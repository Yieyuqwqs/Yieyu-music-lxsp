// Aurora-27：31 段（三分之一倍频程）均衡器内核（纯 C++，无 JNI 依赖，方便单测）
//
// 老板三条硬要求，逐条落到代码上：
//
// ①「31 段算力要高，但不能把手机烧了」
//   · 浮点级联 + 只处理“真正在起作用”的频段：gain==0 且状态已衰减完的分节直接跳过；
//     日常挂两三个点调音时，实际只跑 2~3 个分节，不是 31 个。
//   · 系数只在增益变化时重算（每次 1 次 powf + 4 次乘加），稳态一帧都不算。
//   · 热路径零分配、零锁、零 JNI 拷贝、零文件 IO。
//
// ②「绝对不能有爆音」
//   · 增益在 dB 域做一阶平滑（30ms），系数按 32 帧一拍重算 —— 参数变化是“滑”过去的。
//   · 开关 EQ = 干湿交叉淡变（20ms），不是硬切；10↔31 段切换 = 两条链路 30ms 交叉淡变。
//   · 频段归零后不立刻把系数换成恒等（那会把 biquad 内部残留状态直接甩到输出上 = 啪一声），
//     而是保持真实 peaking 系数让状态按极点自然衰减，衰减到 -140dB 以下才断开。
//   · 滤波器状态只在“输出已经是干信号（wet==0）”时才清零，任何有声时刻都不清状态。
//
// ③「不能有电流声 / 沙沙声」
//   · denormal 冲洗：状态 magnitude < 1e-18 直接归零，长期静音之后不会掉进 ARM 的慢路径。
//   · 非有限值（NaN/Inf）逐分节兜底；输出再兜一层 ±8 上限，脏数据绝不外流。
//   · 自动预衰减（Auto Headroom）：把整条曲线在各个中心频点上的实际叠加提升算出来，
//     超出 +6dB 的部分用平滑预衰减抵掉（压低 40ms / 放回 250ms），
//     避免大增益叠加把后面的限幅器/软削波压出“刺啦”声。可在 UI 里关掉。

#ifndef YIEYU_EQ31_H
#define YIEYU_EQ31_H

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <new>

namespace yieyu {

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
constexpr int kMaxBands = 31;      // 31 段（三分之一倍频程）
constexpr int kTenBands = 10;      // 兼容老的十段
constexpr int kMaxChannels = 8;    // 状态数组上限（实际按 configure 的声道数用）
constexpr int kChunk = 32;         // 增益平滑 / 系数重算的粒度（帧，约 0.7ms@44.1k）
constexpr double kPi = 3.14159265358979323846;
constexpr float kMaxGainDb = 15.f;

// ISO 266 三分之一倍频程中心频率：20Hz ~ 20kHz 共 31 段
constexpr float kThirdOctaveFreq[kMaxBands] = {
    20.f, 25.f, 31.5f, 40.f, 50.f, 63.f, 80.f, 100.f, 125.f, 160.f,
    200.f, 250.f, 315.f, 400.f, 500.f, 630.f, 800.f, 1000.f, 1250.f, 1600.f,
    2000.f, 2500.f, 3150.f, 4000.f, 5000.f, 6300.f, 8000.f, 10000.f, 12500.f, 16000.f,
    20000.f,
};

// 老十段（与 Java 版同一套频点，切回去听感一致）
constexpr float kTenBandFreq[kTenBands] = {
    31.f, 62.f, 125.f, 250.f, 500.f, 1000.f, 2000.f, 4000.f, 8000.f, 16000.f,
};

// 带宽 N 个倍频程的峰值滤波器 Q：Q = sqrt(2^N) / (2^N - 1)
constexpr float kThirdOctaveQ = 4.318474f;  // N = 1/3
constexpr float kOctaveQ = 1.414214f;       // N = 1（老十段用的就是 1.4）

// 平滑时间常数（秒）
constexpr double kGainTau = 0.030;   // 单段增益
constexpr double kWetTau = 0.020;    // 开关 EQ 的淡入淡出
constexpr double kXfadeTau = 0.030;  // 10 段 <-> 31 段
constexpr double kTrimTau = 0.250;   // 自动预衰减（放回）
constexpr double kTrimAttackTau = 0.040;  // 自动预衰减（压下）

// 一阶平滑系数：k = 1 - exp(-dt/tau)，dt 为一步的时长（秒）
inline float smoothCoef(double tau, int stepFrames, int rate) {
    if (rate <= 0 || tau <= 0) return 1.f;
    const double dt = static_cast<double>(stepFrames) / static_cast<double>(rate);
    const double k = 1.0 - std::exp(-dt / tau);
    if (k < 0.0) return 0.f;
    if (k > 1.0) return 1.f;
    return static_cast<float>(k);
}

// 转置直接 II 型 biquad（数值上比直接 I 型稳，低频高 Q 也不会炸）
struct Coef {
    float b0, b1, b2, a1, a2;
};

// 一条完整链路（10 段或 31 段），两条链路可以同时存在并交叉淡变
struct Chain {
    int bands = 0;
    const float* freq = nullptr;
    float q = kThirdOctaveQ;

    // 预计算：每个频点的 sin(w0)、cos(w0)、alpha 基
    float sinW[kMaxBands];
    float cosW[kMaxBands];
    float alpha[kMaxBands];
    // 各中心频点的 cos/sin(ω0) 与 cos/sin(2ω0)：只给重叠估算用（每段中心点数固定，不随参数变）
    float cosI[kMaxBands];
    float sinI[kMaxBands];
    float cos2I[kMaxBands];
    float sin2I[kMaxBands];

    Coef coef[kMaxBands];
    float coefGain[kMaxBands];   // 算系数时用的增益（判断要不要重算）
    float gain[kMaxBands];       // 当前（平滑后的）增益 dB
    float target[kMaxBands];     // 目标增益 dB

    // 每个声道独立的状态
    float s1[kMaxChannels][kMaxBands];
    float s2[kMaxChannels][kMaxBands];

    bool engaged[kMaxBands];
    int liveIdx[kMaxBands];
    int liveCount = 0;

    void setup(int bandCount, const float* freqs, float bandQ, int rate) {
        bands = bandCount;
        freq = freqs;
        q = bandQ;
        resetStates();
        for (int b = 0; b < bands; ++b) {
            const double w0 = 2.0 * kPi * static_cast<double>(freqs[b]) / static_cast<double>(rate);
            const double sw = std::sin(w0);
            sinW[b] = static_cast<float>(sw);
            cosW[b] = static_cast<float>(std::cos(w0));
            alpha[b] = static_cast<float>(sw / (2.0 * static_cast<double>(bandQ)));
            cosI[b] = static_cast<float>(std::cos(w0));
            sinI[b] = static_cast<float>(sw);
            cos2I[b] = static_cast<float>(std::cos(2.0 * w0));
            sin2I[b] = static_cast<float>(std::sin(2.0 * w0));
            gain[b] = 0.f;
            target[b] = 0.f;
            updateCoef(b);
        }
        liveCount = 0;
    }

    void resetStates() {
        std::memset(s1, 0, sizeof(s1));
        std::memset(s2, 0, sizeof(s2));
        std::memset(engaged, 0, sizeof(engaged));
        liveCount = 0;
    }

    bool stateTiny(int b) const {
        const float eps = 1e-7f;
        for (int ch = 0; ch < kMaxChannels; ++ch) {
            const float a = s1[ch][b];
            const float c = s2[ch][b];
            if (a > eps || a < -eps || c > eps || c < -eps) return false;
        }
        return true;
    }

    void clearState(int b) {
        for (int ch = 0; ch < kMaxChannels; ++ch) {
            s1[ch][b] = 0.f;
            s2[ch][b] = 0.f;
        }
    }

    // RBJ peaking EQ，和 Java 版公式逐项一致
    void updateCoef(int b) {
        const float g = gain[b];
        const float a = std::pow(10.f, g / 40.f);
        const float al = alpha[b];
        const float a0 = 1.f + al / a;
        const float inv = 1.f / a0;
        Coef& c = coef[b];
        c.b0 = (1.f + al * a) * inv;
        c.b1 = (-2.f * cosW[b]) * inv;
        c.b2 = (1.f - al * a) * inv;
        c.a1 = c.b1;
        c.a2 = (1.f - al / a) * inv;
        coefGain[b] = g;
    }

    // 一拍（kChunk 帧）的增益平滑 + 分节盘点
    void step(float k) {
        int live = 0;
        for (int b = 0; b < bands; ++b) {
            const float t = target[b];
            float g = gain[b];
            if (g != t) {
                g += (t - g) * k;
                if (std::fabs(t - g) < 0.005f) g = t;
                gain[b] = g;
                updateCoef(b);
            }
            bool run = false;
            if (g > 1e-4f || g < -1e-4f) {
                run = true;
            } else if (engaged[b]) {
                // 归零后继续跑到状态彻底衰减，再断开（否则就是“啪”一声）
                if (stateTiny(b)) {
                    clearState(b);
                    engaged[b] = false;
                } else {
                    run = true;
                }
            }
            if (run) {
                engaged[b] = true;
                liveIdx[live++] = b;
            }
        }
        liveCount = live;
    }

    // 目标增益直接落地（EQ 关闭时用：没有声音，不需要平滑）
    void snap() {
        for (int b = 0; b < bands; ++b) {
            if (gain[b] != target[b]) {
                gain[b] = target[b];
                updateCoef(b);
            }
        }
        resetStates();
    }

    // 就地处理 n 帧（n <= kChunk），ch 为声道下标
    void processChunk(float* buf, int n, int ch) {
        float* s1c = s1[ch];
        float* s2c = s2[ch];
        const float denorm = 1e-18f;
        for (int k = 0; k < liveCount; ++k) {
            const int b = liveIdx[k];
            const Coef c = coef[b];
            float v1 = s1c[b];
            float v2 = s2c[b];
            for (int i = 0; i < n; ++i) {
                const float x = buf[i];
                const float y = c.b0 * x + v1;
                v1 = c.b1 * x - c.a1 * y + v2;
                v2 = c.b2 * x - c.a2 * y;
                buf[i] = y;
            }
            // denormal 冲洗（静音后状态会掉到 1e-30 量级，ARM 上那是慢路径）
            if (v1 < denorm && v1 > -denorm) v1 = 0.f;
            if (v2 < denorm && v2 > -denorm) v2 = 0.f;
            // 非有限值兜底：宁可这一段归零，也不把 NaN 扩散到后面的环绕/头追
            if (!(v1 > -1.f && v1 < 1.f)) v1 = std::isfinite(v1) ? v1 : 0.f;
            if (!(v2 > -1.f && v2 < 1.f)) v2 = std::isfinite(v2) ? v2 : 0.f;
            s1c[b] = v1;
            s2c[b] = v2;
        }
    }
};

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------
class Eq31Core {
public:
    Eq31Core() = default;
    ~Eq31Core() = default;

    Eq31Core(const Eq31Core&) = delete;
    Eq31Core& operator=(const Eq31Core&) = delete;

    bool configure(int rate, int channels) {
        if (rate < 8000 || rate > 768000) return false;
        if (channels < 1 || channels > kMaxChannels) return false;
        rate_ = rate;
        channels_ = channels;
        ten_.setup(kTenBands, kTenBandFreq, kOctaveQ, rate);
        wide_.setup(kMaxBands, kThirdOctaveFreq, kThirdOctaveQ, rate);
        cur_ = &wide_;
        nxt_ = &ten_;
        activeBands_ = kMaxBands;
        xfading_ = false;
        xf_ = 0.f;
        wet_ = 0.f;
        wetNext_ = 0.f;
        trim_ = 1.f;
        trimTarget_ = 1.f;
        kGain_ = smoothCoef(kGainTau, kChunk, rate);
        kWet_ = smoothCoef(kWetTau, kChunk, rate);
        kXfade_ = smoothCoef(kXfadeTau, kChunk, rate);
        kTrim_ = smoothCoef(kTrimTau, kChunk, rate);
        // 预衰减"往下压"要快（0.04s，挡住增益突增那一两下），"放回来"要慢（0.25s，避免音量呼吸感）
        kTrimFast_ = smoothCoef(kTrimAttackTau, kChunk, rate);
        trimHash_ = 0;
        // std::atomic 默认构造不保证清零，这里显式归零，避免刚建句柄时读到垃圾增益
        float zero10[kTenBands] = {0.f};
        float zero31[kMaxBands] = {0.f};
        setGains10(zero10);
        setGains31(zero31);
        return true;
    }

    // ---- 参数（UI 线程写，音频线程读，全部无锁）----
    void setGains10(const float* gains) {
        for (int i = 0; i < kTenBands; ++i) gain10_[i].store(gains[i], std::memory_order_relaxed);
    }
    void setGains31(const float* gains) {
        for (int i = 0; i < kMaxBands; ++i) gain31_[i].store(gains[i], std::memory_order_relaxed);
    }
    void setBands(int bands) { bands_.store(bands, std::memory_order_relaxed); }
    void setEnabled(bool on) { enabled_.store(on ? 1 : 0, std::memory_order_relaxed); }
    void setHeadroom(bool on) { headroom_.store(on ? 1 : 0, std::memory_order_relaxed); }

    void reset() {
        ten_.resetStates();
        wide_.resetStates();
        wet_ = wetNext_ = 0.f;
        xf_ = 0.f;
        xfading_ = false;
        trim_ = trimTarget_ = 1.f;
    }

    /**
     * 就地处理一帧块。data[ch] 是各声道首地址，frames 任意长度（内部按 32 帧切）。
     * 关闭状态下直接原样返回（一个乘法都不做）。
     */
    void process(float* const* data, int frames, int channels) {
        if (rate_ <= 0 || frames <= 0 || channels <= 0) return;
        if (channels > channels_) return;  // 没有按这个声道数配置过：宁可不处理

        const int wantBands = bands_.load(std::memory_order_relaxed);
        const bool wantOn = enabled_.load(std::memory_order_relaxed) != 0 && wantBands > 0;
        const bool headroom = headroom_.load(std::memory_order_relaxed) != 0;

        refreshTargets();

        // ---- 10 <-> 31 段切换：有声时交叉淡变，无声时直接换 ----
        if (wantBands > 0 && wantBands != activeBands_) {
            Chain* next = (wantBands == kTenBands) ? &ten_ : &wide_;
            if (wet_ <= 0.f && !xfading_) {
                cur_ = next;
                activeBands_ = next->bands;
                cur_->snap();
                xfading_ = false;
                xf_ = 0.f;
            } else if (!xfading_) {
                nxt_ = next;
                nxt_->resetStates();   // 新链路从零状态开始，交叉淡变会盖住起始瞬态
                for (int b = 0; b < nxt_->bands; ++b) nxt_->gain[b] = 0.f;
                xfading_ = true;
                xf_ = 0.f;
            }
        }

        // ---- 自动预衰减：按"整条曲线的实际最大提升"抵掉超出 +6dB 的部分 ----
        refreshTrim(headroom, wantOn);

        // ---- 完全关闭且已淡出：落到直通，顺手把状态清干净 ----
        if (!wantOn && wet_ <= 0.f && !xfading_) {
            ten_.snap();
            wide_.snap();
            trim_ = trimTarget_;
            liveBands_.store(0, std::memory_order_relaxed);
            return;
        }

        int pos = 0;
        while (pos < frames) {
            const int n = std::min(kChunk, frames - pos);
            stepAll(wantOn);
            applyChunk(data, pos, n, channels);
            wet_ = wetNext_;
            if (xfading_ && xf_ >= 1.f) finishXfade();
            pos += n;
        }

        // 淡出完成：此时输出已经是纯干信号，清状态不会出声
        if (!wantOn && wet_ <= 0.f) {
            ten_.resetStates();
            wide_.resetStates();
            xfading_ = false;
            xf_ = 0.f;
            liveBands_.store(0, std::memory_order_relaxed);
        }
    }

    // ---- 诊断 ----
    float trimDb() const { return trimDb_.load(std::memory_order_relaxed); }
    int liveBands() const { return liveBands_.load(std::memory_order_relaxed); }
    int rate() const { return rate_; }
    int channels() const { return channels_; }

private:
    /** 某个 biquad 在第 i 个中心频点上的幅度响应（dB），用预先算好的 cos/sin */
    static float magDbAt(const Coef& c, const Chain& ch, int i) {
        const float c1 = ch.cosI[i];
        const float s1 = ch.sinI[i];
        const float c2 = ch.cos2I[i];
        const float s2 = ch.sin2I[i];
        const float re = c.b0 + c.b1 * c1 + c.b2 * c2;
        const float im = -(c.b1 * s1 + c.b2 * s2);
        const float dr = 1.f + c.a1 * c1 + c.a2 * c2;
        const float di = -(c.a1 * s1 + c.a2 * s2);
        const float num = re * re + im * im;
        const float den = dr * dr + di * di;
        if (!(num > 1e-30f) || !(den > 1e-30f)) return 0.f;
        return 10.f * std::log10(num / den);
    }

    /**
     * 自动预衰减：按"当前整条曲线在各个频点上的实际叠加提升"取最大值，
     * 超出 +6dB 的部分用平滑预衰减抵掉 —— 31 段全推满也压不出刺啦声。
     * 只有目标增益变了才重算（哈希比对），稳态零开销。
     */
    void refreshTrim(bool headroom, bool wantOn) {
        const int n = cur_->bands;
        std::uint32_t hash = 2166136261u;
        hash = (hash ^ static_cast<std::uint32_t>(n)) * 16777619u;
        hash = (hash ^ static_cast<std::uint32_t>(headroom ? 1u : 0u)) * 16777619u;
        hash = (hash ^ static_cast<std::uint32_t>(wantOn ? 1u : 0u)) * 16777619u;
        for (int b = 0; b < n; ++b) {
            const int scaled = static_cast<int>(cur_->target[b] * 100.f);
            hash = (hash ^ static_cast<std::uint32_t>(scaled)) * 16777619u;
        }
        if (hash == trimHash_) return;
        trimHash_ = hash;

        float estimate = 0.f;
        if (headroom && wantOn) {
            // 用目标增益现算一遍系数（n 次 powf），再在每个中心频点上求和
            Coef coef[kMaxBands];
            for (int j = 0; j < n; ++j) {
                const float g = cur_->target[j];
                const float av = std::pow(10.f, g / 40.f);
                const float al = cur_->alpha[j];
                const float a0 = 1.f + al / av;
                const float inv = 1.f / a0;
                coef[j].b0 = (1.f + al * av) * inv;
                coef[j].b1 = (-2.f * cur_->cosW[j]) * inv;
                coef[j].b2 = (1.f - al * av) * inv;
                coef[j].a1 = coef[j].b1;
                coef[j].a2 = (1.f - al / av) * inv;
            }
            for (int i = 0; i < n; ++i) {
                float sum = 0.f;
                for (int j = 0; j < n; ++j) {
                    if (cur_->target[j] != 0.f) sum += magDbAt(coef[j], *cur_, i);
                }
                if (sum > estimate) estimate = sum;
            }
        }
        const float trimDb = estimate > 6.f ? 6.f - estimate : 0.f;
        trimTargetDb_ = trimDb;
        trimTarget_ = std::pow(10.f, trimDb / 20.f);
        trimDb_.store(trimDb, std::memory_order_relaxed);
    }

    void refreshTargets() {
        const float nyquistGuard = 0.48f * static_cast<float>(rate_);
        for (int b = 0; b < kTenBands; ++b) {
            float g = gain10_[b].load(std::memory_order_relaxed);
            // 边界必须是闭区间：UI 能拉到正好 ±15dB，开区间会把最大的那档悄悄吃掉
            if (!(g >= -kMaxGainDb && g <= kMaxGainDb)) g = 0.f;  // 顺带挡掉 NaN（比较恒为 false）
            if (kTenBandFreq[b] >= nyquistGuard) g = 0.f;
            ten_.target[b] = g;
        }
        for (int b = 0; b < kMaxBands; ++b) {
            float g = gain31_[b].load(std::memory_order_relaxed);
            if (!(g >= -kMaxGainDb && g <= kMaxGainDb)) g = 0.f;
            if (kThirdOctaveFreq[b] >= nyquistGuard) g = 0.f;
            wide_.target[b] = g;
        }
    }

    void stepAll(bool wantOn) {
        // 干湿
        const float wetTarget = wantOn ? 1.f : 0.f;
        float next = wet_ + (wetTarget - wet_) * kWet_;
        if (wetTarget == 1.f && next > 0.9995f) next = 1.f;
        if (wetTarget == 0.f && next < 5e-4f) next = 0.f;
        wetNext_ = next;

        // 预衰减：压低快、放回慢
        trim_ += (trimTarget_ - trim_) * (trimTarget_ < trim_ ? kTrimFast_ : kTrim_);
        if (std::fabs(trimTarget_ - trim_) < 1e-4f) trim_ = trimTarget_;

        // 增益
        cur_->step(kGain_);
        if (xfading_) {
            nxt_->step(kGain_);
            float x = xf_ + (1.f - xf_) * kXfade_;
            if (x > 0.9995f) x = 1.f;
            xf_ = x;
        }
        liveBands_.store(cur_->liveCount, std::memory_order_relaxed);
    }

    void finishXfade() {
        Chain* old = cur_;
        cur_ = nxt_;
        nxt_ = old;
        activeBands_ = cur_->bands;
        old->resetStates();
        xfading_ = false;
        xf_ = 0.f;
    }

    void applyChunk(float* const* data, int pos, int n, int channels) {
        const float w0 = wet_;
        const float dw = (wetNext_ - wet_) / static_cast<float>(n);
        for (int ch = 0; ch < channels; ++ch) {
            float* d = data[ch] + pos;
            for (int i = 0; i < n; ++i) scratch_[i] = d[i] * trim_;
            cur_->processChunk(scratch_, n, ch);
            if (xfading_) {
                for (int i = 0; i < n; ++i) scratchB_[i] = d[i] * trim_;
                nxt_->processChunk(scratchB_, n, ch);
                const float x = xf_;
                for (int i = 0; i < n; ++i) scratch_[i] += (scratchB_[i] - scratch_[i]) * x;
            }
            float w = w0;
            for (int i = 0; i < n; ++i) {
                const float dry = d[i];
                float out = dry + (scratch_[i] - dry) * w;
                w += dw;
                // NaN / Inf / 爆表 -> 静音兜底（!(a>b) 对 NaN 恒为 true）
                if (!(out > -8.f && out < 8.f)) out = 0.f;
                d[i] = out;
            }
        }
    }

    int rate_ = 0;
    int channels_ = 0;
    Chain ten_;
    Chain wide_;
    Chain* cur_ = nullptr;
    Chain* nxt_ = nullptr;
    int activeBands_ = 0;

    float wet_ = 0.f;
    float wetNext_ = 0.f;
    float xf_ = 0.f;
    bool xfading_ = false;
    float trim_ = 1.f;
    float trimTarget_ = 1.f;

    float kGain_ = 0.02f;
    float kWet_ = 0.03f;
    float kXfade_ = 0.02f;
    float kTrim_ = 0.002f;
    float kTrimFast_ = 0.02f;

    float scratch_[kChunk] = {0};
    float scratchB_[kChunk] = {0};

    // 自动预衰减的哈希（目标增益没变就不重算）
    std::uint32_t trimHash_ = 0;
    float trimTargetDb_ = 0.f;

    std::atomic<float> gain10_[kTenBands];
    std::atomic<float> gain31_[kMaxBands];
    std::atomic<int> bands_{kMaxBands};
    std::atomic<int> enabled_{0};
    std::atomic<int> headroom_{1};
    std::atomic<float> trimDb_{0.f};
    std::atomic<int> liveBands_{0};
};

}  // namespace yieyu

#endif  // YIEYU_EQ31_H
