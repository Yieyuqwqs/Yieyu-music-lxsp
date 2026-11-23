cmake_minimum_required(VERSION 3.22.1)
project(yieyu_core CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# SQLite amalgamation（public domain）：大歌单/容器的正主
set(SQLITE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/sqlite")
# wasm3（MIT）：客户端内嵌 WASM 解释器，用来安全跑音源插件
set(WASM3_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/wasm3")

add_library(yieyu_core SHARED
    jni/jni_entry.cpp
    runtime/core_runtime.cpp
    store/sqlite_store.cpp
    state/state_box.cpp
    ${SQLITE_DIR}/sqlite3.c
    wasm/wasm_runtime.cpp
    ${WASM3_DIR}/m3_core.c
    ${WASM3_DIR}/m3_env.c
    ${WASM3_DIR}/m3_parse.c
    ${WASM3_DIR}/m3_exec.c
    ${WASM3_DIR}/m3_module.c
    ${WASM3_DIR}/m3_function.c
    ${WASM3_DIR}/m3_info.c
    ${WASM3_DIR}/m3_bind.c
    ${WASM3_DIR}/m3_code.c
    ${WASM3_DIR}/m3_compile.c
    ${WASM3_DIR}/m3_validate.c
    ${WASM3_DIR}/m3_xxh64.c
    ${WASM3_DIR}/m3_snapshot.c)

target_include_directories(yieyu_core PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${SQLITE_DIR}"
    "${WASM3_DIR}")

# sqlite3 的定制：去掉用不到的东西，减小体积、降低风险
target_compile_definitions(yieyu_core PRIVATE
    SQLITE_THREADSAFE=1
    SQLITE_DEFAULT_MEMSTATUS=0
    SQLITE_DEFAULT_WAL_SYNCHRONOUS=1
    SQLITE_OMIT_LOAD_EXTENSION
    SQLITE_OMIT_DEPRECATED
    SQLITE_OMIT_SHARED_CACHE
    SQLITE_MAX_VARIABLE_NUMBER=64
    d_m3HasFloat=1)

target_compile_options(yieyu_core PRIVATE -Wall -Wextra -Wno-unused-parameter)
# 第三方源码不参与自家告警门槛
set_source_files_properties(${SQLITE_DIR}/sqlite3.c PROPERTIES COMPILE_OPTIONS "-w")
# wasm3 是第三方源码，不参与自家告警门槛
set_source_files_properties(
    ${WASM3_DIR}/m3_core.c ${WASM3_DIR}/m3_env.c ${WASM3_DIR}/m3_parse.c ${WASM3_DIR}/m3_exec.c
    ${WASM3_DIR}/m3_module.c ${WASM3_DIR}/m3_function.c ${WASM3_DIR}/m3_info.c ${WASM3_DIR}/m3_bind.c
    ${WASM3_DIR}/m3_code.c ${WASM3_DIR}/m3_compile.c ${WASM3_DIR}/m3_validate.c ${WASM3_DIR}/m3_xxh64.c
    ${WASM3_DIR}/m3_snapshot.c
    PROPERTIES COMPILE_OPTIONS "-w")

target_link_libraries(yieyu_core log)
