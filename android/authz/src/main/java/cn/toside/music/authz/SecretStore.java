package cn.toside.music.authz;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.Charset;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 应用内「小密钥抽屉」：Keystore AES-256-GCM，**不要求指纹**。
 *
 * 存在的理由：管理端要落盘一个 GitHub PAT（repo 写权限）。以前它明文躺在
 * AsyncStorage 里（`yieyu.admin.token`），任何能读到应用私有目录的东西都能直接拿走。
 *
 * 与 SecureTokenStore 的区别（刻意不合并）：
 *   · SecureTokenStore 存的是「授权令牌」，硬约束是每次读写都要过指纹 → 必须 BiometricPrompt；
 *   · 这里存的是「工具类凭据」，要在后台静默读写 → 不能要求指纹，只依赖 Keystore 硬件密钥。
 *
 * 硬约束：密钥永不导出；密文与 IV 分开存；解密失败一律当"没有"（返回 null），绝不降级成明文。
 */
final class SecretStore {
  private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "yieyu_app_secret_v1";
  private static final String PREF_NAME = "yieyu_app_secrets";
  private static final String TRANSFORMATION = "AES/GCM/NoPadding";
  private static final int GCM_TAG_BITS = 128;
  private static final Charset UTF8 = Charset.forName("UTF-8");

  private final Context context;

  SecretStore(Context context) {
    this.context = context.getApplicationContext();
  }

  private SharedPreferences prefs() {
    return context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
  }

  private SecretKey ensureKey() throws Exception {
    final KeyStore store = KeyStore.getInstance(ANDROID_KEYSTORE);
    store.load(null);
    if (store.containsAlias(KEY_ALIAS)) {
      final java.security.Key existing = store.getKey(KEY_ALIAS, null);
      if (existing instanceof SecretKey) return (SecretKey) existing;
    }
    final KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
    generator.init(new KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build());
    return generator.generateKey();
  }

  void put(String name, String value) throws Exception {
    final Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.ENCRYPT_MODE, ensureKey());
    final byte[] cipherText = cipher.doFinal(value.getBytes(UTF8));
    final byte[] iv = cipher.getIV();
    if (cipherText == null || iv == null) throw new IllegalStateException("加密失败");
    prefs().edit()
        .putString(name + ".ct", Base64.encodeToString(cipherText, Base64.NO_WRAP))
        .putString(name + ".iv", Base64.encodeToString(iv, Base64.NO_WRAP))
        .commit();
  }

  /** 读不到 / 解不开都返回 null（调用方按"没有"处理，不许回落到明文） */
  String get(String name) {
    final String cipherText = prefs().getString(name + ".ct", null);
    final String iv = prefs().getString(name + ".iv", null);
    if (cipherText == null || iv == null) return null;
    try {
      final Cipher cipher = Cipher.getInstance(TRANSFORMATION);
      cipher.init(Cipher.DECRYPT_MODE, ensureKey(),
          new GCMParameterSpec(GCM_TAG_BITS, Base64.decode(iv, Base64.NO_WRAP)));
      final byte[] plain = cipher.doFinal(Base64.decode(cipherText, Base64.NO_WRAP));
      return new String(plain, UTF8);
    } catch (Throwable error) {
      // 密钥失效（恢复出厂/换机）或密文损坏：当作没有，顺手清干净
      remove(name);
      return null;
    }
  }

  void remove(String name) {
    prefs().edit().remove(name + ".ct").remove(name + ".iv").commit();
  }
}
