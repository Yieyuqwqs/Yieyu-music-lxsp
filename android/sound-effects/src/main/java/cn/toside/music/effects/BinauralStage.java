package cn.toside.music.effects;

import android.content.Context;

/**
 * 头追双耳渲染的一层封装：持有 HRTF 渲染器 + 传感器跟踪，做耳机门控与线程安全的前后切换。
 *
 * 创建/销毁都发生在后台线程；音频线程只通过 volatile 引用取用，销毁前留 250ms 余量，
 * 保证正在处理的那一块不会用到已经释放的句柄。
 */
final class BinauralStage {
    private static final Object LOCK = new Object();
    private static volatile BinauralStage current;

    private final HrtfRenderer renderer;
    private final HeadTracker tracker;
    private final float[] orientation = new float[9];
    private volatile boolean retired;

    private BinauralStage(HrtfRenderer renderer, HeadTracker tracker) {
        this.renderer = renderer;
        this.tracker = tracker;
    }

    static BinauralStage current() {
        return current;
    }

    static boolean ready() {
        return current != null;
    }

    /** 后台线程调用：按采样率准备好渲染器（重复调用是廉价的空操作）。 */
    static void prepare(Context context, int sampleRate, int frameSize) {
        BinauralStage existing = current;
        if (existing != null && existing.renderer.matches(sampleRate, frameSize)) return;
        if (!HrtfRenderer.available()) return;
        AudioRoute.start(context);
        HeadTracker tracker = HeadTracker.create(context);
        if (tracker == null) return;
        HrtfRenderer renderer = HrtfRenderer.create(sampleRate, frameSize);
        if (renderer == null) return;
        tracker.start();
        BinauralStage stage = new BinauralStage(renderer, tracker);
        BinauralStage previous;
        synchronized (LOCK) {
            previous = current;
            current = stage;
        }
        if (previous != null) previous.retire();
    }

    /** 关闭头追：立即让音频线程看不到，再延后释放。 */
    static void stop() {
        BinauralStage previous;
        synchronized (LOCK) {
            previous = current;
            current = null;
        }
        if (previous != null) previous.retire();
    }

    /** 音频线程调用：返回值表示这块是否真的经过了 HRTF。 */
    boolean process(float[] left, float[] right, int frames) {
        if (retired || !AudioRoute.isHeadset()) return false;
        if (tracker.readPose(orientation)) renderer.setListener(orientation);
        return renderer.process(left, right, frames);
    }

    /** 音频线程：seek/暂停恢复时清状态，避免残留卷积导致爆音或静音 */
    void reset() {
        if (retired) return;
        renderer.reset();
    }

    float yaw() {
        return tracker.yaw();
    }

    float prediction() {
        return tracker.prediction();
    }

    private void retire() {
        retired = true;
        final HrtfRenderer oldRenderer = renderer;
        final HeadTracker oldTracker = tracker;
        SoundEffects.runOnWorker(() -> {
            try {
                Thread.sleep(250);
            } catch (InterruptedException ignored) {
            }
            oldRenderer.release();
            oldTracker.stop();
        });
    }
}
