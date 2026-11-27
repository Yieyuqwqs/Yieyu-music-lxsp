cmake_minimum_required(VERSION 3.22.1)
project(yieyu_authz CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 授权核：密钥 / 设备码 / 白名单条目 / 迁移码全在这层，Java 只做平台适配（指纹、Keystore、广播）
add_library(yieyu_authz SHARED
    authz_core.cpp
    jni_authz.cpp)

target_include_directories(yieyu_authz PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")

# 体积与速度：-Os，外加把符号尽量藏着（不靠它保密，只是少暴露点线索）
target_compile_options(yieyu_authz PRIVATE -Os -fvisibility=hidden -fvisibility-inlines-hidden)
set_target_properties(yieyu_authz PROPERTIES
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN ON)
