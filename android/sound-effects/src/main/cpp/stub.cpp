// 占位实现：该 ABI 没有 Steam Audio 预编译库时，保证模块仍能编译出 .so，
// Java 侧 loadLibrary 成功后 nativeCreate 返回 0，头追功能自动关闭。
extern "C" long yieyu_hrtf_stub_marker() {
    return 0;
}
