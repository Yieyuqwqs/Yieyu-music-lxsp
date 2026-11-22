# 头追 / HRTF：JNI 方法不能被混淆或裁剪
-keep class cn.toside.music.effects.HrtfRenderer { *; }
-keepclasseswithmembernames class cn.toside.music.effects.HrtfRenderer { native <methods>; }
-keep class cn.toside.music.effects.HeadTracker { *; }
-keep class cn.toside.music.effects.BinauralStage { *; }
-keep class cn.toside.music.effects.AudioRoute { *; }

# JTransforms / jlargearrays 引用 Android 上不存在的 sun.misc.Cleaner
-dontwarn sun.misc.**
-dontwarn pl.edu.icm.jlargearrays.**
