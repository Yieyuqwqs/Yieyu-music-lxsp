package cn.toside.music.authz;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 授权令牌的加密抽屉（Android Keystore，AES-256-GCM）。
 *
 * 硬约束：
 * 1. 密钥在 Keystore 里，永不导出；Java/JS 都拿不到明文密钥。
 * 2. 密钥要求「每次使用都验证指纹」（CryptoObject 模式），所以读写都必须走 BiometricPrompt。
 * 3. 用户新增/删除指纹 → 密钥作废（KeyPermanentlyInvalidatedException）→ 必须重新绑定。
 */
final class SecureTokenStore {
  private static final String TAG = "YieyuAuthz";
  private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "yieyu_authz_token_v1";
  private static final String PREF_NAME = "yieyu_authz_token";
  private static final String FIELD_CIPHER = "ct";
  private static final String FIELD_IV = "iv";
  private static final String TRANSFORMATION = "AES/GCM/NoPadding";

  private final Context context;
  private final SecureRandom random = new SecureRandom();

  SecureTokenStore(Context context) {
    this.context = context.getApplicationContext();
  }

  private SharedPreferences prefs() {
    return context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
  }

  boolean hasToken() {
    final String cipherText = prefs().getString(FIELD_CIPHER, null);
    return cipherText != null && cipherText.length() > 0;
  }

  /** 解除本机绑定：删密文 + 删 Keystore 密钥 */
  void clear() {
    try {
      prefs().edit().clear().commit();
    } catch (Throwable error) {
      Log.w(TAG, "clear prefs failed", error);
    }
    try {
      final KeyStore store = KeyStore.getInstance(ANDROID_KEYSTORE);
      store.load(null);
      if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
    } catch (Throwable error) {
      Log.w(TAG, "delete keystore entry failed", error);
    }
  }

  /** 开始一次加密（还未写盘，等指纹验证通过后 commit） */
  Cipher beginEncrypt() throws Exception {
    final Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.ENCRYPT_MODE, ensureKey());
    return cipher;
  }

  void commit(Cipher cipher, byte[] plain) throws Exception {
    final byte[] cipherText = cipher.doFinal(plain);
    final byte[] iv = cipher.getIV();
    if (cipherText == null || iv == null) throw new IllegalStateException("加密失败");
    prefs().edit()
        .putString(FIELD_CIPHER, Base64.encodeToString(cipherText, Base64.NO_WRAP))
        .putString(FIELD_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
        .commit();
  }

  /** 开始一次解密（等指纹验证通过后 finishRead） */
  Cipher beginDecrypt() throws Exception {
    final String cipherText = prefs().getString(FIELD_CIPHER, null);
    final String iv = prefs().getString(FIELD_IV, null);
    if (cipherText == null || iv == null) throw new IllegalStateException("本机还没绑定指纹授权");

    final KeyStore store = KeyStore.getInstance(ANDROID_KEYSTORE);
    store.load(null);
    if (!store.containsAlias(KEY_ALIAS)) throw new IllegalStateException("本机授权密钥已失效，请重新绑定指纹");

    final java.security.Key stored = store.getKey(KEY_ALIAS, null);
    if (!(stored instanceof SecretKey)) throw new IllegalStateException("本机授权密钥不可用");

    final Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.DECRYPT_MODE, (SecretKey) stored,
        new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
    return cipher;
  }

  String finishRead(Cipher cipher) throws Exception {
    final String cipherText = prefs().getString(FIELD_CIPHER, null);
    if (cipherText == null) throw new IllegalStateException("本机授权已被清除");
    final byte[] plain = cipher.doFinal(Base64.decode(cipherText, Base64.NO_WRAP));
    return new String(plain, "UTF-8");
  }

  /** Keystore 里的 AES 密钥：没有就建，要求每次使用做一次强生物识别 */
  private SecretKey ensureKey() throws Exception {
    final KeyStore store = KeyStore.getInstance(ANDROID_KEYSTORE);
    store.load(null);
    if (store.containsAlias(KEY_ALIAS)) {
      final java.security.Key existing = store.getKey(KEY_ALIAS, null);
      if (existing instanceof SecretKey) return (SecretKey) existing;
      store.deleteEntry(KEY_ALIAS);
    }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      throw new IllegalStateException("系统版本过低（需要 Android 6.0+）");
    }

    final KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
    final KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .setUserAuthenticationRequired(true);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // API 30+：只认强生物识别，永久有效期内不允许「刚刚验证过就复用」
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
    } else {
      // API 23~29：-1 = 每次使用都要验证（CryptoObject 模式）
      builder.setUserAuthenticationValidityDurationSeconds(-1);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      // 指纹集合发生变化（新增/删除指纹）→ 密钥自动作废
      builder.setInvalidatedByBiometricEnrollment(true);
    }

    generator.init(builder.build());
    final SecretKey key = generator.generateKey();
    if (key == null) throw new IllegalStateException("无法生成授权密钥");
    return key;
  }

  /** 给「没有 Android ID」的极端设备兜底用 */
  String randomHex(int bytes) {
    final byte[] buffer = new byte[bytes];
    random.nextBytes(buffer);
    final StringBuilder out = new StringBuilder(bytes * 2);
    for (byte value : buffer) out.append(String.format("%02x", value & 0xFF));
    return out.toString();
  }
}
