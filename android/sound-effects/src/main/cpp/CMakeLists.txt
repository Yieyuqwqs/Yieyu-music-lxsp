cmake_minimum_required(VERSION 3.22.1)
project(yieyu_hrtf CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(PHONON_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}")

if(NOT EXISTS "${PHONON_DIR}/libphonon.so")
    # 其他 ABI 没有预编译的 Steam Audio：头追编译空壳（运行时加载失败后自动关闭），
    # Hi-Res 升频是纯 DSP，不依赖 Steam Audio，所有 ABI 都编进去
    message(STATUS "[yieyu-hrtf] no libphonon.so for ${ANDROID_ABI}, building stub + hires")
    add_library(yieyu_hrtf SHARED stub.cpp hires_jni.cpp eq31_jni.cpp vinyl_jni.cpp)
    target_link_libraries(yieyu_hrtf log m)
    return()
endif()

add_library(phonon SHARED IMPORTED)
set_target_properties(phonon PROPERTIES IMPORTED_LOCATION "${PHONON_DIR}/libphonon.so")

add_library(yieyu_hrtf SHARED hrtf_jni.cpp hires_jni.cpp eq31_jni.cpp vinyl_jni.cpp)
target_include_directories(yieyu_hrtf PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(yieyu_hrtf phonon log android m)
