package cn.toside.music.core;

/**
 * C++ → Java 的唯一回调面（M0）。
 *
 * 线程约定：这两个方法**只会**在 C++ 的 core-disp 线程被调用，
 * 绝不在音频线程、也绝不在 JS 线程。实现方必须做到「投递完立刻返回」，
 * 不允许在这里做 IO / 加锁等待 / 反向同步调用 C++。
 */
public interface CoreCallback {
  /** 状态/诊断事件，topic 形如 "core.pong"、"player.state" */
  void onEvent(String topic, String json);

  /** request() 的一次性应答（由 Java 侧按 id 找回 Promise 并 resolve） */
  void onResponse(long requestId, String json);
}
