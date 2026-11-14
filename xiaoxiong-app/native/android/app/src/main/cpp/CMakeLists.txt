# 编译 JNI 桥 libgatewaynode.so（Android，NDK/CMake）。自包含：不依赖脚本注入变量、不依赖绝对路径。
#
# 依赖（均由 package-android-offline.mjs 落入工程）：
#   - src/main/jniLibs/<abi>/libnode.so      digidem 预编译运行库（按 ABI 分）
#   - src/main/cpp/include/node/              digidem 发布包的 include/node 头（v8.h / node.h 等）
#   - src/main/cpp/gateway_node_bridge.cpp   本 JNI 桥源码
# AGP 会按 ABI 分别调用 CMake 并注入 ${ANDROID_ABI}，据此选对应 libnode.so。
cmake_minimum_required(VERSION 3.22.1)
project(gatewaynode CXX)

set(CMAKE_CXX_STANDARD 20)  # Node 24 / V8 头要求 C++20，v8config.h 有硬性检查
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(NODE_LIB "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")
set(NODE_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/include/node")

if(NOT EXISTS "${NODE_LIB}")
  message(FATAL_ERROR "缺少 ${NODE_LIB}：先跑 package-android-offline.mjs --node-lib 拷入 digidem libnode.so")
endif()
if(NOT EXISTS "${NODE_INCLUDE}/node.h")
  message(FATAL_ERROR "缺少 ${NODE_INCLUDE}/node.h：从 digidem 包拷入 include/node/")
endif()

# 预编译库用 IMPORTED target 正确链接（比把 .so 路径直接塞进 target_link_libraries 可靠）
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION "${NODE_LIB}")

add_library(gatewaynode SHARED
    gateway_node_bridge.cpp)

target_include_directories(gatewaynode PRIVATE "${NODE_INCLUDE}")

# liblog 用于 __android_log_print；libnode 提供 node::Start
target_link_libraries(gatewaynode
    node
    log)

# 产物 libgatewaynode.so 由 AGP 打进 APK；libnode.so 已在 jniLibs，运行时由
# System.loadLibrary("node") 先显式加载，保证 DT_NEEDED 依赖可解析。
