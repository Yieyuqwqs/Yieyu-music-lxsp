// 极客功能一：本地插值升频（Hi-Res）
// 多相 Blackman 窗 sinc 重采样：把解码后的 PCM 直接插到 96/192kHz，
// 由 AudioTrack 以高采样率输出，不再依赖系统那条廉价的线性插值。
//
// Aurora-15「冷链防抖」在原生侧的两件事：
//   1) 动态缓冲：按目标输出采样率给硬缓冲 —— 192kHz=256ms、96kHz=150ms、48kHz=100ms。
//      create() 时按计划一次性分配到位，render() 热路径永不分配内存（192kHz 抽搐的诱因之一）。
//   2) 低负载插值：每输出帧只把两行相位表按权重混成一个 48 抽头 float 核（两个声道共用），
//      之后每声道只做 48 次乘加；原来每个声道两行表各算一遍 double 乘加（96 次），
//      192kHz 下等于每秒 3.7 千万次 double 乘加，把音频线程直接烧穿 —— 这就是「疯狂抽搐」。
//
// 约束：render() 只在音频线程调用，热路径不分配内存（仅容量不足时扩容一次）。

#include <jni.h>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <new>

namespace {

constexpr int kTaps = 48;          // 每相抽头数（偶数）
constexpr int kHalf = kTaps / 2;
constexpr int kMaxPhases = 1024;   // 相位表上限，超过时在两行之间线性插值
constexpr double kPi = 3.14159265358979323846;

// 冷链缓冲计划：目标输出采样率越高，硬缓冲越厚（毫秒）
constexpr int kBufferMs192 = 256;  // 192kHz 档：200~300ms 区间
constexpr int kBufferMs96 = 150;   // 96kHz 档
constexpr int kBufferMs48 = 100;   // 48kHz 档
constexpr int kMinPlanFrames = 4096;
constexpr int kMaxPlanFrames = 262144;

int bufferMsForRate(int outRate) {
    if (outRate >= 176400) return kBufferMs192;
    if (outRate >= 88200) return kBufferMs96;
    return kBufferMs48;
}

struct Resampler {
    int channels = 0;
    int inRate = 0;
    int outRate = 0;
    long long up = 1;        // out/in = up/down（已约分）
    long long down = 1;
    int phases = 0;
    int bufferMs = kBufferMs48;  // 该档位的硬缓冲时长
    int planFrames = 0;          // 缓冲计划覆盖的输入帧数（Java 侧按它预分配）
    float* table = nullptr;      // phases * kTaps
    float* hist = nullptr;       // channels * kTaps（上一块末尾的历史样本）
    float* work = nullptr;       // channels * workCap（历史 + 本块输入）
    int workCap = 0;
    long long consumed = 0;  // 已消费的输入帧总数
    long long output = 0;    // 已产出的输出帧总数（跨块连续）
};

long long gcdll(long long a, long long b) {
    if (a < 0) a = -a;
    if (b < 0) b = -b;
    while (b != 0) {
        const long long t = a % b;
        a = b;
        b = t;
    }
    return a == 0 ? 1 : a;
}

double sincValue(double x) {
    if (std::fabs(x) < 1e-9) return 1.0;
    const double px = kPi * x;
    return std::sin(px) / px;
}

// Blackman 窗：旁瓣低，插值不会出现「嗡嗡」的镜像残留
double blackman(double t) {
    if (t <= -1.0 || t >= 1.0) return 0.0;
    const double x = kPi * (t + 1.0);
    return 0.42 - 0.5 * std::cos(x) + 0.08 * std::cos(2.0 * x);
}

/** 按目标输出采样率算出该档的硬缓冲计划（毫秒 + 输入帧数） */
void computePlan(Resampler* rs) {
    rs->bufferMs = bufferMsForRate(rs->outRate);
    const long long outFrames = ((long long) rs->outRate * (long long) rs->bufferMs + 999) / 1000;
    long long inFrames = (outFrames * rs->down + rs->up - 1) / rs->up;  // 向上取整
    if (inFrames < kMinPlanFrames) inFrames = kMinPlanFrames;
    if (inFrames > kMaxPlanFrames) inFrames = kMaxPlanFrames;
    rs->planFrames = (int) inFrames;
}

bool buildTable(Resampler* rs) {
    rs->phases = (int) (rs->up <= kMaxPhases ? rs->up : kMaxPhases);
    if (rs->phases < 2) rs->phases = 2;
    const size_t size = (size_t) rs->phases * (size_t) kTaps;
    rs->table = new (std::nothrow) float[size];
    if (rs->table == nullptr) return false;
    for (int p = 0; p < rs->phases; p++) {
        const double frac = (double) p / (double) rs->phases;
        double sum = 0.0;
        for (int i = 0; i < kTaps; i++) {
            const double d = (double) (i - (kHalf - 1));
            const double t = frac - d;
            const double value = sincValue(t) * blackman(t / (double) kHalf);
            rs->table[(size_t) p * kTaps + i] = (float) value;
            sum += value;
        }
        // 每相归一化到 DC 增益 1，避免音量随重采样跳变
        if (sum > 1e-6 || sum < -1e-6) {
            const float norm = (float) (1.0 / sum);
            for (int i = 0; i < kTaps; i++) rs->table[(size_t) p * kTaps + i] *= norm;
        }
    }
    return true;
}

/**
 * 工作区按「历史 + 本块」连续排列，容量至少覆盖该档位的缓冲计划，
 * 这样正常播放（4096 帧以内的块）永远不会在音频线程里重新分配。
 */
void ensureWork(Resampler* rs, int frames) {
    int need = frames + kTaps;
    if (need < rs->planFrames + kTaps) need = rs->planFrames + kTaps;
    if (rs->work != nullptr && need <= rs->workCap) return;
    float* next = new (std::nothrow) float[(size_t) rs->channels * (size_t) need];
    if (next == nullptr) return;
    delete[] rs->work;
    rs->work = next;
    rs->workCap = need;
}

Resampler* fromHandle(jlong handle) {
    return reinterpret_cast<Resampler*>(handle);
}

void releaseResampler(Resampler* rs) {
    if (rs == nullptr) return;
    delete[] rs->table;
    delete[] rs->hist;
    delete[] rs->work;
    delete rs;
}

}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_cn_toside_music_effects_HiRes_nativeCreate(JNIEnv*, jclass, jint inRate, jint outRate, jint channels) {
    if (inRate < 8000 || outRate < 8000 || channels < 1 || channels > 8) return 0;
    if (outRate <= inRate) return 0;
    Resampler* rs = new (std::nothrow) Resampler();
    if (rs == nullptr) return 0;
    rs->channels = channels;
    rs->inRate = inRate;
    rs->outRate = outRate;
    const long long g = gcdll(inRate, outRate);
    rs->up = outRate / g;
    rs->down = inRate / g;
    computePlan(rs);
    if (!buildTable(rs)) {
        releaseResampler(rs);
        return 0;
    }
    rs->hist = new (std::nothrow) float[(size_t) channels * kTaps];
    if (rs->hist == nullptr) {
        releaseResampler(rs);
        return 0;
    }
    std::memset(rs->hist, 0, sizeof(float) * (size_t) channels * kTaps);
    ensureWork(rs, rs->planFrames);
    if (rs->work == nullptr) {
        releaseResampler(rs);
        return 0;
    }
    return reinterpret_cast<jlong>(rs);
}

JNIEXPORT void JNICALL
Java_cn_toside_music_effects_HiRes_nativeDestroy(JNIEnv*, jclass, jlong handle) {
    releaseResampler(fromHandle(handle));
}

JNIEXPORT void JNICALL
Java_cn_toside_music_effects_HiRes_nativeReset(JNIEnv*, jclass, jlong handle) {
    Resampler* rs = fromHandle(handle);
    if (rs == nullptr || rs->hist == nullptr) return;
    std::memset(rs->hist, 0, sizeof(float) * (size_t) rs->channels * kTaps);
    rs->consumed = 0;
    rs->output = 0;
}

/** 该档位的硬缓冲时长（毫秒），Java 侧写进诊断行做真机核对 */
JNIEXPORT jint JNICALL
Java_cn_toside_music_effects_HiRes_nativeBufferMs(JNIEnv*, jclass, jlong handle) {
    Resampler* rs = fromHandle(handle);
    return rs == nullptr ? 0 : (jint) rs->bufferMs;
}

/** 该档位缓冲计划覆盖的输入帧数，Java 侧按它预分配 pcmIn/pcmOut */
JNIEXPORT jint JNICALL
Java_cn_toside_music_effects_HiRes_nativePlanFrames(JNIEnv*, jclass, jlong handle) {
    Resampler* rs = fromHandle(handle);
    return rs == nullptr ? 0 : (jint) rs->planFrames;
}

/** 输出容量：ceil(frames * out/in) + 2，Java 侧先按它分配缓冲 */
JNIEXPORT jint JNICALL
Java_cn_toside_music_effects_HiRes_nativeCapacity(JNIEnv*, jclass, jlong handle, jint frames) {
    Resampler* rs = fromHandle(handle);
    if (rs == nullptr || frames <= 0) return 0;
    return (jint) (((long long) frames * rs->up / rs->down) + 2);
}

/**
 * 重采样一块交织 PCM16。返回实际写出的输出帧数。
 * 输出数组容量必须 >= nativeCapacity(frames)。
 */
JNIEXPORT jint JNICALL
Java_cn_toside_music_effects_HiRes_nativeRender(JNIEnv* env, jclass, jlong handle,
                                                jshortArray inputArray, jint frames,
                                                jshortArray outputArray) {
    Resampler* rs = fromHandle(handle);
    if (rs == nullptr || frames <= 0 || frames > (1 << 20)) return 0;
    ensureWork(rs, frames);
    if (rs->work == nullptr) return 0;
    const int channels = rs->channels;
    const int stride = rs->workCap;
    const long long total = rs->consumed + frames;
    const int outCapacity = (int) (((long long) frames * rs->up / rs->down) + 2);

    jshort* input = env->GetShortArrayElements(inputArray, nullptr);
    if (input == nullptr) return 0;
    jshort* output = env->GetShortArrayElements(outputArray, nullptr);
    if (output == nullptr) {
        env->ReleaseShortArrayElements(inputArray, input, JNI_ABORT);
        return 0;
    }

    // 1) 拼出「历史 + 本块」连续工作区（避免热路径取模寻址）
    for (int ch = 0; ch < channels; ch++) {
        float* row = rs->work + (size_t) ch * (size_t) stride;
        std::memcpy(row, rs->hist + (size_t) ch * kTaps, sizeof(float) * kTaps);
        const jshort* src = input + ch;
        float* dst = row + kTaps;
        for (int i = 0; i < frames; i++) {
            dst[i] = (float) src[(size_t) i * (size_t) channels] * (1.0f / 32768.0f);
        }
    }

    // 2) 逐输出样本做多相插值：输出序号绝对递增，跨块连续。
    //    插值核每个输出帧只混一次（两个声道共用），单声道 48 次乘加就够。
    float kernel[kTaps];
    int produced = 0;
    for (long long k = rs->output; produced < outCapacity; k++) {
        const long long n = (k * rs->down) / rs->up;   // 对应输入位置（整数部分）
        if (n + kHalf > total - 1) break;
        const long long frac = (k * rs->down) % rs->up;
        const double pos = (double) frac * (double) rs->phases / (double) rs->up;
        int p0 = (int) pos;
        float weight = (float) (pos - (double) p0);
        if (p0 >= rs->phases - 1) {
            p0 = rs->phases - 2;
            weight = 1.0f;
        }
        const float* r0 = rs->table + (size_t) p0 * kTaps;
        const float* r1 = r0 + kTaps;
        if (weight <= 0.0f) {
            std::memcpy(kernel, r0, sizeof(float) * kTaps);
        } else if (weight >= 1.0f) {
            std::memcpy(kernel, r1, sizeof(float) * kTaps);
        } else {
            const float inverse = 1.0f - weight;
            for (int i = 0; i < kTaps; i++) {
                kernel[i] = r0[i] * inverse + r1[i] * weight;
            }
        }
        // 输入下标 s 在工作区里的位置 = kTaps + (s - consumed)
        const long long base = n - rs->consumed + (long long) kTaps - (kHalf - 1);
        const bool inRange = base >= 0 && base + kTaps <= (long long) kTaps + frames;
        for (int ch = 0; ch < channels; ch++) {
            float value = 0.0f;
            if (inRange) {
                const float* src = rs->work + (size_t) ch * (size_t) stride + (size_t) base;
                float acc = 0.0f;
                for (int i = 0; i < kTaps; i++) acc += kernel[i] * src[i];
                value = acc;
            }
            if (value > 1.0f) value = 1.0f;
            else if (value < -1.0f) value = -1.0f;
            const int sample = (int) (value * 32767.0f + (value >= 0.0f ? 0.5f : -0.5f));
            output[(size_t) produced * (size_t) channels + (size_t) ch] = (jshort) sample;
        }
        produced++;
        rs->output = k + 1;
    }

    // 3) 保留最后 kTaps 个样本作为下一块的历史
    for (int ch = 0; ch < channels; ch++) {
        float* hist = rs->hist + (size_t) ch * kTaps;
        const float* row = rs->work + (size_t) ch * (size_t) stride;
        if (frames >= kTaps) {
            std::memcpy(hist, row + frames, sizeof(float) * kTaps);
        } else {
            std::memmove(hist, hist + frames, sizeof(float) * (size_t) (kTaps - frames));
            std::memcpy(hist + kTaps - frames, row + kTaps, sizeof(float) * (size_t) frames);
        }
    }
    rs->consumed = total;

    env->ReleaseShortArrayElements(outputArray, output, 0);
    env->ReleaseShortArrayElements(inputArray, input, JNI_ABORT);
    return (jint) produced;
}

}  // extern "C"
