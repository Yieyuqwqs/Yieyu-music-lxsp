package cn.toside.music.effects;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;

/**
 * 头部朝向跟踪：只读 game rotation vector（陀螺+加速度融合，不用磁力计，室内不会被磁干扰）。
 *
 * 输出的是「相对开启时刻」的姿态（right/up/ahead 三个单位向量，坐标系与 Steam Audio 一致：
 * +X 右、+Y 上、−Z 前），所以手机怎么拿着都不影响，只看转动增量。
 *
 * 1. 水平（绕 Y）全量跟随；俯仰/翻滚（手机倾斜，和真实点头关系弱）衰减到 30%。
 * 2. 用相邻两帧四元数估角速度，外推到 PREDICT_MS 之后 —— 抵消 AudioTrack 缓冲带来的延迟。
 * 3. 传感器事件在独立线程，音频线程只读 volatile 数组，不加锁、不分配。
 */
final class HeadTracker implements SensorEventListener {
    /** 预测提前量：约等于输出链路延迟（缓冲 60~120ms + 系统混音），太大会过冲 */
    static final int PREDICT_MS = 120;
    private static final float TILT_SCALE = 0.30f;
    private static final float[] IDENTITY_POSE = {1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, -1f};

    private final SensorManager manager;
    private final Sensor sensor;
    private HandlerThread thread;
    private Handler handler;
    private boolean running;

    private final float[] reference = new float[4];
    private boolean hasReference;
    private float[] previousRaw;
    private long previousNanos;

    private volatile float[] pose = IDENTITY_POSE.clone();
    private volatile boolean hasSample;
    private volatile float yawDegrees;
    private volatile float predictionDegrees;

    private HeadTracker(Context context) {
        manager = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
        Sensor candidate = manager == null ? null : manager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (candidate == null && manager != null) candidate = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        sensor = candidate;
    }

    static HeadTracker create(Context context) {
        HeadTracker tracker = new HeadTracker(context);
        return tracker.available() ? tracker : null;
    }

    boolean available() {
        return sensor != null && manager != null;
    }

    synchronized void start() {
        if (running || !available()) return;
        thread = new HandlerThread("yieyu-head-tracker");
        thread.start();
        handler = new Handler(thread.getLooper());
        hasReference = false;
        hasSample = false;
        previousRaw = null;
        pose = IDENTITY_POSE.clone();
        // 10ms ≈ 100Hz：够平滑，功率可忽略；maxReportLatency 0 表示立即上报
        running = manager.registerListener(this, sensor, 10_000, 0, handler);
        if (!running) {
            thread.quitSafely();
            thread = null;
            handler = null;
        }
    }

    synchronized void stop() {
        if (manager != null) manager.unregisterListener(this);
        running = false;
        if (thread != null) {
            thread.quitSafely();
            thread = null;
            handler = null;
        }
        hasSample = false;
    }

    boolean hasPose() {
        return hasSample;
    }

    float yaw() {
        return yawDegrees;
    }

    float prediction() {
        return predictionDegrees;
    }

    /** 音频线程调用：拿当前姿态（right/up/ahead 顺序的 9 个分量），没有数据时返回 false。 */
    boolean readPose(float[] out) {
        if (!hasSample || out == null || out.length < 9) return false;
        float[] current = pose;
        System.arraycopy(current, 0, out, 0, 9);
        return true;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.values.length < 4) return;
        long now = SystemClock.elapsedRealtimeNanos();
        float[] raw = {event.values[0], event.values[1], event.values[2], event.values[3]};
        if (!hasReference) {
            reference[0] = raw[0];
            reference[1] = raw[1];
            reference[2] = raw[2];
            reference[3] = raw[3];
            hasReference = true;
            previousRaw = raw;
            previousNanos = now;
            pose = IDENTITY_POSE.clone();
            hasSample = true;
            return;
        }

        // 世界坐标下的增量旋转（q_now · q_ref⁻¹），这样手机横放/竖放都只按真实水平转角生效
        float[] relative = normalize(multiply(raw, conjugate(reference)));
        float omegaY = 0f;
        if (previousRaw != null && now > previousNanos) {
            float seconds = (now - previousNanos) / 1e9f;
            if (seconds > 0.0005f && seconds < 0.5f) {
                float[] delta = normalize(multiply(raw, conjugate(previousRaw)));
                if (delta[3] < 0f) {
                    delta[0] = -delta[0];
                    delta[1] = -delta[1];
                    delta[2] = -delta[2];
                    delta[3] = -delta[3];
                }
                float sinHalf = (float) Math.sqrt(Math.max(0f, 1f - delta[3] * delta[3]));
                if (sinHalf > 1e-4f) {
                    float angle = 2f * (float) Math.acos(clamp(delta[3], -1f, 1f));
                    omegaY = (delta[1] / sinHalf) * angle / seconds;
                }
            }
        }
        previousRaw = raw;
        previousNanos = now;

        // 纯水平分量：绕 Y 轴的旋转角
        double yaw = 2d * Math.atan2(relative[1], relative[3]);
        if (yaw > Math.PI) yaw -= 2d * Math.PI;
        else if (yaw < -Math.PI) yaw += 2d * Math.PI;
        double predict = omegaY * (PREDICT_MS / 1000d) * 0.75d;
        double predictedYaw = yaw + clamp(predict, -0.6d, 0.6d);

        float[] yawQuat = {0f, (float) Math.sin(yaw / 2d), 0f, (float) Math.cos(yaw / 2d)};
        float[] residual = normalize(multiply(conjugate(yawQuat), relative));
        float[] tilt = nlerpIdentity(residual, TILT_SCALE);
        float[] predictedYawQuat = {0f, (float) Math.sin(predictedYaw / 2d), 0f, (float) Math.cos(predictedYaw / 2d)};
        float[] combined = normalize(multiply(predictedYawQuat, tilt));

        pose = basis(combined);
        hasSample = true;
        yawDegrees = (float) Math.toDegrees(predictedYaw);
        predictionDegrees = (float) Math.toDegrees(predict);
    }

    @Override
    public void onAccuracyChanged(Sensor changed, int accuracy) {
    }

    // ---------------- 四元数工具（都在传感器线程上跑，允许少量临时对象） ----------------

    private static float[] multiply(float[] a, float[] b) {
        return new float[]{
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
        };
    }

    private static float[] conjugate(float[] q) {
        return new float[]{-q[0], -q[1], -q[2], q[3]};
    }

    private static float[] normalize(float[] q) {
        float length = (float) Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        if (length < 1e-6f) return new float[]{0f, 0f, 0f, 1f};
        return new float[]{q[0] / length, q[1] / length, q[2] / length, q[3] / length};
    }

    /** 从单位四元数向 identity 插值 factor：用来衰减抬头/歪头 */
    private static float[] nlerpIdentity(float[] q, float factor) {
        float[] result = {q[0] * factor, q[1] * factor, q[2] * factor, 1f + (q[3] - 1f) * factor};
        return normalize(result);
    }

    /** 由四元数得到 right/up/ahead 三个基向量 */
    private static float[] basis(float[] q) {
        float x = q[0], y = q[1], z = q[2], w = q[3];
        float xx = x * x, yy = y * y, zz = z * z;
        float xy = x * y, xz = x * z, yz = y * z;
        float wx = w * x, wy = w * y, wz = w * z;
        // 旋转矩阵的三列：right / up / back(= -ahead)
        float r00 = 1f - 2f * (yy + zz), r10 = 2f * (xy + wz), r20 = 2f * (xz - wy);
        float r01 = 2f * (xy - wz), r11 = 1f - 2f * (xx + zz), r21 = 2f * (yz + wx);
        float r02 = 2f * (xz + wy), r12 = 2f * (yz - wx), r22 = 1f - 2f * (xx + yy);
        return new float[]{
            r00, r10, r20,
            r01, r11, r21,
            -r02, -r12, -r22,
        };
    }

    private static float clamp(float value, float min, float max) {
        return value < min ? min : value > max ? max : value;
    }

    private static double clamp(double value, double min, double max) {
        return value < min ? min : value > max ? max : value;
    }
}
