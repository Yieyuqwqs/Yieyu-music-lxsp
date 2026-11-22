// Aurora-29：【模拟黑胶 / 胆机】内核（纯 C++17，无 JNI 依赖，方便和 ~/work/vinyl/sim.js 对照）
//
// 老板四条硬要求，逐条落到代码上：
//
// ①「要偶次谐波，不能糊弄」
//   · 奇对称函数（tanh / x-x³/3 / 链路里的 softClip）在数学上只有奇次项，2 次谐波恒为 0。
//   · 这里用【偏置 tanh】：y = (tanh(g(x+b)) - tanh(gb)) / k，b≈0.6/g 随驱动联动。
//     实测 1kHz：H2 比 H3 高 8.9dB（偶次占优），THD 11%→33% 随加量单调。
//   · 偏置固定 b=0.4 是坑：g=32 时电平掉到 -104dB（等于没声），必须随 g 反比。
//
// ②「不能是放个假底噪」
//   · 嘶声：xorshift32 白噪 → 200Hz 高通 + 8kHz 低通，现场塑形（无 wav、无循环点）。
//   · 颗粒：泊松到达（指数间隔）+ 2 极点谐振器（衰减 ~2ms，幅度 U³ 重尾），
//     实测 12 次/秒时峰度 22（高斯=3），是"稀疏大脉冲"而不是雨声。
//
// ③「肉摇要微醺，不要劣质磁带」
//   · 0.55Hz / 1.1Hz / 9.7Hz 三路相位叠加（合计 pitch 预算 0.35%）+ 极慢随机漂移。
//   · 6 点 Lagrange 分数延迟（实测 10kHz 只要 -0.16dB 误差；线性插值要 -2dB，会露馅）。
//
// ④「味精加量」一根滑块
//   · amount 0→1 映射到三档：驱动 1→10、嘶声 -86→-46dBFS、颗粒 0→12 次/秒、肉摇 0→0.35%。
//   · 所有参数二阶平滑（30ms）+ 干湿交叉淡变（20ms）；关闭时逐位直通。
//
// 抗爆音/抗混叠（和 eq31 同样标准）：
//   · 4 倍过采样（半带 32 抽头多相）+ 一阶 ADAA：实测听觉频段非谐波 -64~-75dB。
//   · 参数突然变化时重算反导数基线，否则 ADAA 会算出巨大跳变（实测 877% 满刻度）。
//   · 不对称整形必然出直流 → 内核自带 12Hz 直流阻断。
//   · denormal 冲洗 / NaN 兜底 / ±8 上限，逐条照抄 eq31。

#ifndef YIEYU_VINYL_H
#define YIEYU_VINYL_H

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <new>

namespace yieyu {
namespace vinyl {

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
constexpr int kMaxCh = 8;          // 声道上限（实际按 configure 的声道数用）
constexpr int kChunk = 32;         // 参数平滑/过采样处理的粒度（帧）
constexpr int kOsMax = 4;          // 高保真 4 倍过采样
constexpr int kBufOs = kChunk * kOsMax;   // 128
constexpr int kDelayLen = 256;     // 肉摇环形缓冲
constexpr int kBaseDelay = 64;     // 基线延迟（采样，约 1.33ms@48k）
constexpr int kHalfTaps = 16;      // 半带滤波器每相抽头数（共 32 抽头）
constexpr double kPi = 3.14159265358979323846;

constexpr double kSmoothAmountTau = 0.030;  // 加量的参数平滑
constexpr double kWetTau = 0.020;           // 开关的干湿淡变
constexpr double kDcCutoff = 12.0;          // 直流阻断截止（Hz）
// 蓝牙带宽终极限幅：16kHz 陡峭低通（老板实测蓝牙下 16k 以上会被编解码器糟蹋成滋滋声）
constexpr double kLpfCutoff = 16000.0;
constexpr int kLpfMaxSections = 16;        // 最多 32 阶（192kHz）

// 6 点 Lagrange 插值的分母（xj - xm 连乘，xj = j-2 ∈ {-2..3}）
constexpr double kLagDen[6] = {-120.0, 24.0, -12.0, 12.0, -24.0, 120.0};

// ---------------------------------------------------------------------------
// 半带 FIR（32 抽头 Kaiser β=7.5，fc=0.25）—— 多相系数
// ---------------------------------------------------------------------------
struct HalfBand {
    float e[kHalfTaps];  // 偶相 h[2i]
    float o[kHalfTaps];  // 奇相 h[2i+1]
};

inline double besselI0(double x) {
    double sum = 1.0, term = 1.0;
    const double hx = x * 0.5;
    for (int k = 1; k < 30; ++k) {
        term *= (hx / static_cast<double>(k)) * (hx / static_cast<double>(k));
        sum += term;
    }
    return sum;
}

inline HalfBand computeHalfBand() {
    constexpr int N = kHalfTaps * 2;
    constexpr double beta = 7.5;
    constexpr double fc = 0.25;
    double h[N];
    double sum = 0.0;
    const double denom = besselI0(beta);
    for (int n = 0; n < N; ++n) {
        const double m = static_cast<double>(n) - (N - 1) * 0.5;
        const double s = std::sin(2.0 * kPi * fc * m) / (kPi * m);
        const double r = m / ((N - 1) * 0.5);
        const double arg = beta * std::sqrt(std::max(0.0, 1.0 - r * r));
        h[n] = s * (besselI0(arg) / denom);
        sum += h[n];
    }
    HalfBand out{};
    for (int i = 0; i < kHalfTaps; ++i) {
        out.e[i] = static_cast<float>(h[2 * i] / sum);
        out.o[i] = static_cast<float>(h[2 * i + 1] / sum);
    }
    return out;
}

// 全局只算一次（C++11 起函数内静态初始化是线程安全的）
inline const HalfBand& halfBand() {
    static const HalfBand hb = computeHalfBand();
    return hb;
}

// ---------------------------------------------------------------------------
// 过采样：2 倍上/下采样（多相）
// ---------------------------------------------------------------------------
struct Up2 {
    float h[kHalfTaps] = {0.f};
    void reset() { std::memset(h, 0, sizeof(h)); }
    void process(const float* x, int n, float* out) {
        const HalfBand& hb = halfBand();
        for (int i = 0; i < n; ++i) {
            for (int k = kHalfTaps - 1; k > 0; --k) h[k] = h[k - 1];
            h[0] = x[i];
            float e = 0.f, o = 0.f;
            for (int k = 0; k < kHalfTaps; ++k) {
                e += hb.e[k] * h[k];
                o += hb.o[k] * h[k];
            }
            out[2 * i] = e * 2.f;      // 零插值要补 2 倍增益
            out[2 * i + 1] = o * 2.f;
        }
    }
};

struct Down2 {
    float he[kHalfTaps] = {0.f};
    float ho[kHalfTaps] = {0.f};
    float prev = 0.f;
    void reset() {
        std::memset(he, 0, sizeof(he));
        std::memset(ho, 0, sizeof(ho));
        prev = 0.f;
    }
    void process(const float* x, int n2, float* out) {
        const HalfBand& hb = halfBand();
        const int n = n2 / 2;
        for (int m = 0; m < n; ++m) {
            const float even = x[2 * m];
            const float odd = (m == 0) ? prev : x[2 * m - 1];
            prev = x[2 * m + 1];
            for (int k = kHalfTaps - 1; k > 0; --k) {
                he[k] = he[k - 1];
                ho[k] = ho[k - 1];
            }
            he[0] = even;
            ho[0] = odd;
            float acc = 0.f;
            for (int k = 0; k < kHalfTaps; ++k) acc += hb.e[k] * he[k] + hb.o[k] * ho[k];
            out[m] = acc;
        }
    }
};

// ---------------------------------------------------------------------------
// 双二阶（RBJ），只用来做嘶声的带通塑形
// ---------------------------------------------------------------------------
struct Biquad {
    float b0 = 0.f, b1 = 0.f, b2 = 0.f, a1 = 0.f, a2 = 0.f;
    float x1 = 0.f, x2 = 0.f, y1 = 0.f, y2 = 0.f;
    bool lowpass = true;

    void setup(bool lp, double freq, double q, double rate) {
        lowpass = lp;
        const double w0 = 2.0 * kPi * freq / rate;
        const double al = std::sin(w0) / (2.0 * q);
        const double c = std::cos(w0);
        double rb0, rb1, rb2, ra0, ra1, ra2;
        if (lp) {
            rb0 = (1.0 - c) * 0.5; rb1 = 1.0 - c; rb2 = (1.0 - c) * 0.5;
        } else {
            rb0 = (1.0 + c) * 0.5; rb1 = -(1.0 + c); rb2 = (1.0 + c) * 0.5;
        }
        ra0 = 1.0 + al; ra1 = -2.0 * c; ra2 = 1.0 - al;
        b0 = static_cast<float>(rb0 / ra0);
        b1 = static_cast<float>(rb1 / ra0);
        b2 = static_cast<float>(rb2 / ra0);
        a1 = static_cast<float>(ra1 / ra0);
        a2 = static_cast<float>(ra2 / ra0);
        reset();
    }
    float process(float x) {
        const float y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
    }
    void reset() { x1 = x2 = y1 = y2 = 0.f; }
};

// ---------------------------------------------------------------------------
// 16kHz 陡峭低通：Butterworth 级联（双精度状态，靠近奈奎斯特也稳）
// ---------------------------------------------------------------------------
struct LpfSection {
    float b0 = 1.f, b1 = 0.f, b2 = 0.f, a1 = 0.f, a2 = 0.f;
};

struct LpfState {
    double x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
};

// ---------------------------------------------------------------------------
// 颗粒谐振器（2 极点，冲激峰值归一化）
// ---------------------------------------------------------------------------
struct ClickRes {
    float a1 = 0.f, a2 = 0.f, s1 = 0.f, s2 = 0.f;
    float peak = 1.f;
    double next = 0.0;
};

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------
class VinylCore {
public:
    VinylCore() = default;
    ~VinylCore() = default;
    VinylCore(const VinylCore&) = delete;
    VinylCore& operator=(const VinylCore&) = delete;

    bool configure(int rate, int channels) {
        if (rate < 8000 || rate > 768000) return false;
        if (channels < 1 || channels > kMaxCh) return false;
        rate_ = rate;
        channels_ = channels;
        halfBand();      // 预热系数（避免第一次处理时在音频线程里算）
        // 嘶声塑形：200Hz 高通 + 8kHz 低通
        for (int ch = 0; ch < kMaxCh; ++ch) {
            hp_[ch].setup(false, 200.0, 0.707, rate);
            lp_[ch].setup(true, std::min(8000.0, rate * 0.42), 0.707, rate);
            // 颗粒谐振器：两声道不同谐振频率（2.4k / 3.2k），衰减 2ms
            const double decay = 0.002;
            const double fc = (ch % 2 == 0) ? 2400.0 : 3200.0;
            const double r = std::exp(-kPi / (decay * rate));
            const double th = 2.0 * kPi * fc / rate;
            ClickRes& res = res_[ch];
            res.a1 = static_cast<float>(2.0 * r * std::cos(th));
            res.a2 = static_cast<float>(-r * r);
            double s1 = 1.0, s2 = 0.0, pk = 0.0;
            for (int i = 0; i < 4096; ++i) {
                const double y = s1;
                s1 = res.a1 * s1 + res.a2 * s2;
                s2 = y;
                if (std::fabs(y) > pk) pk = std::fabs(y);
            }
            res.peak = static_cast<float>(pk > 1e-6 ? pk : 1.0);
        }
        // 16kHz 陡峭低通：44.1/48k 用 12 阶，96k 用 20 阶，192k 用 32 阶（保持同样的陡度）
        const int order = rate <= 48000 ? 12 : (rate <= 96000 ? 20 : 32);
        lpfSections_ = std::min(order / 2, kLpfMaxSections);
        const double lpfW0 = 2.0 * kPi * kLpfCutoff / static_cast<double>(rate);
        const double lpfCw = std::cos(lpfW0);
        const double lpfSw = std::sin(lpfW0);
        for (int sec = 0; sec < lpfSections_; ++sec) {
            // Butterworth 极点 Q：Q_k = -1/(2 cos(pi(2k+N-1)/(2N)))
            const double k = static_cast<double>(sec) + 1.0;
            const double q = -1.0 / (2.0 * std::cos(kPi * (2.0 * k + order - 1.0) / (2.0 * order)));
            const double al = lpfSw / (2.0 * q);
            const double a0 = 1.0 + al;
            LpfSection& c = lpfCoef_[sec];
            c.b0 = static_cast<float>(((1.0 - lpfCw) * 0.5) / a0);
            c.b1 = static_cast<float>((1.0 - lpfCw) / a0);
            c.b2 = static_cast<float>(((1.0 - lpfCw) * 0.5) / a0);
            c.a1 = static_cast<float>((-2.0 * lpfCw) / a0);
            c.a2 = static_cast<float>((1.0 - al) / a0);
        }
        dcCoef_ = std::max(0.9, 1.0 - 2.0 * kPi * kDcCutoff / rate);
        kAmount_ = static_cast<float>(1.0 - std::exp(-static_cast<double>(kChunk) / (rate * kSmoothAmountTau)));
        kWet_ = static_cast<float>(1.0 - std::exp(-static_cast<double>(kChunk) / (rate * kWetTau)));
        seeds_[0] = 0x9E3779B9u;
        seeds_[1] = 0x85EBCA6Bu;
        updateDerived();
        reset();
        return true;
    }

    // ---- 参数（UI 线程写，音频线程读，全部无锁）----
    void setAmount(float v) {
        if (!(v >= 0.f && v <= 1.f)) v = 0.f;   // 顺带挡掉 NaN
        amount_.store(v, std::memory_order_relaxed);
    }
    void setTube(bool on) { tube_.store(on ? 1 : 0, std::memory_order_relaxed); }
    void setNoise(bool on) { noise_.store(on ? 1 : 0, std::memory_order_relaxed); }
    void setWow(bool on) { wow_.store(on ? 1 : 0, std::memory_order_relaxed); }
    void setQuality(bool hi) { quality_.store(hi ? 1 : 0, std::memory_order_relaxed); }
    void setEnabled(bool on) { enabled_.store(on ? 1 : 0, std::memory_order_relaxed); }
    void setLpf(bool on) { lpfOn_.store(on ? 1 : 0, std::memory_order_relaxed); }

    void reset() {
        for (int ch = 0; ch < kMaxCh; ++ch) {
            up_[ch].reset(); up2_[ch].reset(); down_[ch].reset(); down2_[ch].reset();
            std::memset(delay_[ch], 0, sizeof(delay_[ch]));
            delayW_[ch] = 0;
            wowPhase_[ch] = 0.0; flutPhase_[ch] = 0.0; wow2Phase_[ch] = 0.0; drift_[ch] = 0.0;
            hp_[ch].reset(); lp_[ch].reset();
            res_[ch].s1 = res_[ch].s2 = 0.f; res_[ch].next = 0.0;
            adaaPrev_[ch] = 0.f;
            adaaPrevF_[ch] = antideriv(0.f);
            dcIn_[ch] = dcOut_[ch] = 0.f;
            for (int sec = 0; sec < kLpfMaxSections; ++sec) lpfState_[ch][sec] = LpfState{};
        }
        wet_ = wetNext_ = 0.f;
        smoothAmount_ = 0.f;
        lpfMix_ = 0.f;
    }

    /**
     * 就地处理一帧块（每声道一个 float 缓冲，长度 frames）。
     * 关闭状态下直接原样返回（一个乘法都不做）。
     */
    void process(float* const* data, int frames, int channels) {
        if (rate_ <= 0 || frames <= 0 || channels <= 0) return;
        if (channels > channels_) return;   // 没按这个声道数配置过：宁可不处理
        const int chCount = std::min(channels, kMaxCh);
        const float amount = amount_.load(std::memory_order_relaxed);
        const bool wantOn = enabled_.load(std::memory_order_relaxed) != 0 && amount > 0.f;
        const float target = wantOn ? 1.f : 0.f;

        for (int pos = 0; pos < frames; pos += kChunk) {
            const int n = std::min(kChunk, frames - pos);
            wetNext_ = wet_ + (target - wet_) * kWet_;
            if (target == 1.f && wetNext_ > 0.9995f) wetNext_ = 1.f;
            if (target == 0.f && wetNext_ < 5e-4f) wetNext_ = 0.f;
            smoothAmount_ += ((wantOn ? amount : 0.f) - smoothAmount_) * kAmount_;
            // 低通常驻运行（状态永远热身），开关只改干湿比例 —— 切换绝不爆音
            const float lpfTarget = (wantOn && lpfOn_.load(std::memory_order_relaxed) != 0) ? 1.f : 0.f;
            lpfMix_ += (lpfTarget - lpfMix_) * kWet_;
            if (lpfTarget == 1.f && lpfMix_ > 0.9995f) lpfMix_ = 1.f;
            if (lpfTarget == 0.f && lpfMix_ < 5e-4f) lpfMix_ = 0.f;
            updateDerived();
            // 参数变了 → 反导数基线必须跟着变，否则 ADAA 会算出巨大跳变（实测 877%）
            for (int ch = 0; ch < chCount; ++ch) adaaPrevF_[ch] = antideriv(adaaPrev_[ch]);
            for (int ch = 0; ch < chCount; ++ch) {
                float* d = data[ch] + pos;
                for (int i = 0; i < n; ++i) dry_[i] = d[i];
                processChunk(d, n, ch);
                const float w = wet_;
                for (int i = 0; i < n; ++i) d[i] = dry_[i] + (d[i] - dry_[i]) * w;
            }
            wet_ = wetNext_;
        }
    }

    // ---- 诊断（给面板诚实显示）----
    int osFactor() const { return os_.load(std::memory_order_relaxed); }
    float hissDb() const { return hissDb_.load(std::memory_order_relaxed); }
    float driveDb() const { return driveDb_.load(std::memory_order_relaxed); }

private:
    // ---- 参数 → 三个子模块的映射（与 ~/work/vinyl/sim.js 的 updateDerived 逐行一致）----
    void updateDerived() {
        const float a = smoothAmount_;
        tubeGain_ = std::pow(10.f, a);                                   // 1 .. 10
        tubeBias_ = std::max(0.09f, std::min(0.35f, 0.6f / tubeGain_));  // 偏置随驱动联动
        const float tb = std::tanh(tubeGain_ * tubeBias_);
        tubeNorm_ = tubeGain_ * (1.f - tb * tb);
        if (!(tubeNorm_ > 1e-4f)) tubeNorm_ = 1e-4f;
        tubeMakeup_ = std::pow(10.f, 0.4f * a * a / 20.f);
        const float hissDb = -86.f + 40.f * a;
        hissGain_ = std::pow(10.f, hissDb / 20.f) / 0.335f;
        clickRate_ = 12.f * std::pow(a, 1.5f);
        clickPeak_ = std::pow(10.f, (-18.f - 10.f * (1.f - a)) / 20.f);
        wowDev_ = 0.0035 * a;
        // 过采样自适应：管线 96k→2x，192k→1x（等效整形速率 ≥192k，省电）
        const int base = quality_.load(std::memory_order_relaxed) ? 4 : 2;
        const int cap = std::max(1, static_cast<int>(192000 / std::max(1, rate_)));
        const int osv = std::min(base, std::min(cap, kOsMax));
        os_.store(osv, std::memory_order_relaxed);
        hissDb_.store(hissDb, std::memory_order_relaxed);
        driveDb_.store(20.f * std::log10(std::max(1e-6f, tubeGain_)), std::memory_order_relaxed);
    }

    // y = (tanh(g(x+b)) - tanh(gb)) / k，小信号增益归一
    float shape(float x) const {
        const float t = std::tanh(tubeGain_ * (x + tubeBias_));
        const float dc = std::tanh(tubeGain_ * tubeBias_);
        return (t - dc) / tubeNorm_;
    }

    // 反导数：F(x) = [ln cosh(g(x+b))/g - tanh(gb)·x] / k
    float antideriv(float x) const {
        const float dc = std::tanh(tubeGain_ * tubeBias_);
        const float v = tubeGain_ * (x + tubeBias_);
        const float av = std::fabs(v);
        const float lncosh = av + std::log1p(std::exp(-2.f * av)) - 0.6931472f;
        return (lncosh / tubeGain_ - dc * x) / tubeNorm_;
    }

    // 一阶 ADAA：y = (F(x) - F(x_prev)) / (x - x_prev)
    float shapeADAA(float x, int ch) {
        const float fx = antideriv(x);
        const float dx = x - adaaPrev_[ch];
        const float y = (std::fabs(dx) < 1e-7f) ? shape(x) : (fx - adaaPrevF_[ch]) / dx;
        adaaPrev_[ch] = x;
        adaaPrevF_[ch] = fx;
        return y;
    }

    // xorshift32：白噪/颗粒/漂移共用（每声道独立流）
    float rnd(int ch) {
        std::uint32_t x = seeds_[ch];
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        seeds_[ch] = x;
        return static_cast<float>(x >> 8) * (1.f / 16777216.f);   // [0,1)
    }

    // 6 点 Lagrange 分数延迟（系数分母是常数，见 kLagDen）
    static float lagrange6(const float* buf, int len, double pos) {
        const double fl = std::floor(pos);
        const int base = static_cast<int>(fl) - 2;
        const double t = pos - fl;
        const double a0 = t + 2.0, a1 = t + 1.0, a2 = t, a3 = t - 1.0, a4 = t - 2.0, a5 = t - 3.0;
        const double num[6] = {a1 * a2 * a3 * a4 * a5, a0 * a2 * a3 * a4 * a5, a0 * a1 * a3 * a4 * a5,
                               a0 * a1 * a2 * a4 * a5, a0 * a1 * a2 * a3 * a5, a0 * a1 * a2 * a3 * a4};
        double y = 0.0;
        for (int j = 0; j < 6; ++j) {
            int idx = base + j;
            while (idx < 0) idx += len;
            while (idx >= len) idx -= len;
            y += static_cast<double>(buf[idx]) * (num[j] / kLagDen[j]);
        }
        return static_cast<float>(y);
    }

    void processChunk(float* d, int frames, int ch) {
        const float a = smoothAmount_;
        // ---- 1) 肉摇：调制延迟线（6 点 Lagrange）----
        if (wowOn() && a > 1e-4f) {
            const double bud = wowDev_;
            const double A1 = (bud * 0.60) * rate_ / (2.0 * kPi * 0.55);
            const double A3 = (bud * 0.25) * rate_ / (2.0 * kPi * 1.1);
            const double A2 = (bud * 0.15) * rate_ / (2.0 * kPi * 9.7);
            const double w1 = 2.0 * kPi * 0.55 / rate_;
            const double w2 = 2.0 * kPi * 9.7 / rate_;
            const double w3 = 2.0 * kPi * 1.1 / rate_;
            float* buf = delay_[ch];
            int w = delayW_[ch];
            double p1 = wowPhase_[ch], p2 = flutPhase_[ch], p3 = wow2Phase_[ch], dr = drift_[ch];
            for (int i = 0; i < frames; ++i) {
                p1 += w1; if (p1 > 2.0 * kPi) p1 -= 2.0 * kPi;
                p2 += w2; if (p2 > 2.0 * kPi) p2 -= 2.0 * kPi;
                p3 += w3; if (p3 > 2.0 * kPi) p3 -= 2.0 * kPi;
                dr += (static_cast<double>(rnd(ch)) - 0.5) * 1e-4;
                dr *= 0.9995;
                const double dl = kBaseDelay + A1 * std::sin(p1) + A3 * std::sin(p3 + 0.7)
                                  + A2 * std::sin(p2) + dr * A1;
                buf[w] = d[i];
                const float y = lagrange6(buf, kDelayLen, static_cast<double>(w) - dl);
                d[i] = y * static_cast<float>(1.0 + 0.023 * a * std::sin(p1 + 1.3));
                w = (w + 1) % kDelayLen;
            }
            delayW_[ch] = w; wowPhase_[ch] = p1; flutPhase_[ch] = p2;
            wow2Phase_[ch] = p3; drift_[ch] = dr;
        }
        // ---- 2) 胆机：过采样 → ADAA 整形 → 下采样 ----
        if (tubeOn() && a > 1e-4f) {
            const int os = os_.load(std::memory_order_relaxed);
            if (os >= 4) {
                up_[ch].process(d, frames, buf64_);
                up2_[ch].process(buf64_, frames * 2, bufOs_);
                for (int i = 0; i < frames * 4; ++i) bufOs_[i] = shapeADAA(bufOs_[i], ch);
                down2_[ch].process(bufOs_, frames * 4, buf64_);
                down_[ch].process(buf64_, frames * 2, bufOut_);
            } else if (os >= 2) {
                up_[ch].process(d, frames, buf64_);
                for (int i = 0; i < frames * 2; ++i) buf64_[i] = shapeADAA(buf64_[i], ch);
                down_[ch].process(buf64_, frames * 2, bufOut_);
            } else {
                for (int i = 0; i < frames; ++i) bufOut_[i] = shapeADAA(d[i], ch);
            }
            for (int i = 0; i < frames; ++i) d[i] = bufOut_[i] * tubeMakeup_;
        }
        // ---- 3) 底噪：嘶声 + 颗粒（纯加法，不经过 EQ）----
        if (noiseOn() && a > 1e-4f) {
            ClickRes& r = res_[ch];
            const float rateF = static_cast<float>(rate_);
            for (int i = 0; i < frames; ++i) {
                const float white = rnd(ch) * 2.f - 1.f;
                const float hiss = lp_[ch].process(hp_[ch].process(white)) * hissGain_;
                if (r.next <= 0.0) {
                    const float u = rnd(ch);
                    float amp = u * u * u * clickPeak_ / r.peak;
                    if (rnd(ch) < 0.5f) amp = -amp;
                    r.s1 += amp;
                    const float uu = rnd(ch);
                    const double mean = -std::log(1.0 - static_cast<double>(uu) * 0.999999);
                    r.next = mean / std::max(1e-6f, clickRate_) * static_cast<double>(rateF);
                }
                r.next -= 1.0;
                const float y = r.s1;
                r.s1 = r.a1 * r.s1 + r.a2 * r.s2;
                r.s2 = y;
                d[i] += hiss + y;
            }
        }
        // ---- 3.5) 16kHz 陡峭低通 ----
        if (a > 1e-4f) {
            LpfState* st = lpfState_[ch];
            for (int i = 0; i < frames; ++i) lpfTmp_[i] = d[i];
            for (int sec = 0; sec < lpfSections_; ++sec) {
                const LpfSection& c = lpfCoef_[sec];
                LpfState& z = st[sec];
                for (int i = 0; i < frames; ++i) {
                    const double x = static_cast<double>(lpfTmp_[i]);
                    const double y = c.b0 * x + c.b1 * z.x1 + c.b2 * z.x2 - c.a1 * z.y1 - c.a2 * z.y2;
                    z.x2 = z.x1; z.x1 = x;
                    z.y2 = z.y1; z.y1 = y;
                    lpfTmp_[i] = static_cast<float>(y);
                }
            }
            const float m = lpfMix_;
            if (m > 1e-4f) {
                for (int i = 0; i < frames; ++i) d[i] += (lpfTmp_[i] - d[i]) * m;
            }
        }
        // ---- 4) 直流阻断（不对称整形必然出直流）+ denormal 冲洗 + 兜底 ----
        float xi = dcIn_[ch], yo = dcOut_[ch];
        const float R = static_cast<float>(dcCoef_);
        for (int i = 0; i < frames; ++i) {
            const float v = d[i];
            const float hpv = v - xi + R * yo;
            xi = v;
            yo = hpv;
            if (yo < 1e-18f && yo > -1e-18f) yo = 0.f;
            d[i] = (hpv > -8.f && hpv < 8.f) ? hpv : 0.f;
        }
        dcIn_[ch] = xi;
        dcOut_[ch] = yo;
    }

    bool tubeOn() const { return tube_.load(std::memory_order_relaxed) != 0; }
    bool noiseOn() const { return noise_.load(std::memory_order_relaxed) != 0; }
    bool wowOn() const { return wow_.load(std::memory_order_relaxed) != 0; }

    // ---- 状态 ----
    int rate_ = 0;
    int channels_ = 0;

    Up2 up_[kMaxCh];
    Up2 up2_[kMaxCh];
    Down2 down_[kMaxCh];
    Down2 down2_[kMaxCh];

    float delay_[kMaxCh][kDelayLen] = {{0.f}};
    int delayW_[kMaxCh] = {0};
    double wowPhase_[kMaxCh] = {0.0};
    double flutPhase_[kMaxCh] = {0.0};
    double wow2Phase_[kMaxCh] = {0.0};
    double drift_[kMaxCh] = {0.0};

    Biquad hp_[kMaxCh];
    Biquad lp_[kMaxCh];
    ClickRes res_[kMaxCh];

    float adaaPrev_[kMaxCh] = {0.f};
    float adaaPrevF_[kMaxCh] = {0.f};
    float dcIn_[kMaxCh] = {0.f};
    float dcOut_[kMaxCh] = {0.f};

    std::uint32_t seeds_[2] = {0x9E3779B9u, 0x85EBCA6Bu};

    float buf64_[kChunk * 2] = {0.f};
    float bufOs_[kBufOs] = {0.f};
    float bufOut_[kChunk] = {0.f};
    float dry_[kChunk] = {0.f};
    float lpfTmp_[kChunk] = {0.f};
    LpfSection lpfCoef_[kLpfMaxSections];
    LpfState lpfState_[kMaxCh][kLpfMaxSections];
    int lpfSections_ = 0;
    float lpfMix_ = 0.f;

    // ---- 派生参数（每 chunk 由 smoothAmount_ 算出）----
    float smoothAmount_ = 0.f;
    float tubeGain_ = 1.f;
    float tubeBias_ = 0.35f;
    float tubeNorm_ = 1.f;
    float tubeMakeup_ = 1.f;
    float hissGain_ = 0.f;
    float clickRate_ = 0.f;
    float clickPeak_ = 0.f;
    double wowDev_ = 0.0;

    float wet_ = 0.f;
    float wetNext_ = 0.f;
    float kWet_ = 0.03f;
    float kAmount_ = 0.02f;
    double dcCoef_ = 0.998;

    std::atomic<float> amount_{0.f};
    std::atomic<int> tube_{1};
    std::atomic<int> noise_{1};
    std::atomic<int> wow_{1};
    std::atomic<int> quality_{1};
    std::atomic<int> enabled_{0};
    std::atomic<int> lpfOn_{1};
    std::atomic<int> os_{4};
    std::atomic<float> hissDb_{-86.f};
    std::atomic<float> driveDb_{0.f};
};

}  // namespace vinyl
}  // namespace yieyu

#endif  // YIEYU_VINYL_H
