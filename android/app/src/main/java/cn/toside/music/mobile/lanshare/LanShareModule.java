package cn.toside.music.mobile.lanshare;

import android.os.Environment;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;

import cn.toside.music.mobile.R;

/**
 * 局域网传歌：内置 HTTP 服务，电脑浏览器打开即可拖拽上传音频。
 * 只实现 GET /<token>（网页）与 PUT /upload/<token>?name=... （裸 body 上传，不走 multipart，避免解析坑）。
 * 文件落到 /sdcard/Download/yieyu-import/（写不进时退到应用外部目录）。
 */
public final class LanShareModule extends ReactContextBaseJavaModule {
    private static final String NAME = "LanShareModule";
    private static final long MAX_UPLOAD = 2L * 1024L * 1024L * 1024L;

    private final ReactApplicationContext context;
    private volatile ServerSocket serverSocket;
    private volatile Thread acceptThread;
    private volatile boolean running;
    private volatile String token = "";
    private volatile File saveDir;

    public LanShareModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.context = reactContext;
    }

    @Override
    public String getName() {
        return NAME;
    }

    @ReactMethod
    public void start(Promise promise) {
        try {
            if (running) {
                promise.resolve(describe());
                return;
            }
            saveDir = resolveSaveDir();
            token = newToken();
            ServerSocket socket = new ServerSocket();
            socket.setReuseAddress(true);
            socket.bind(new InetSocketAddress(0));
            serverSocket = socket;
            running = true;
            Thread thread = new Thread(() -> acceptLoop(socket), "yieyu-lanshare");
            thread.setDaemon(true);
            acceptThread = thread;
            thread.start();
            promise.resolve(describe());
        } catch (Throwable error) {
            running = false;
            promise.reject("lan_start_failed", error);
        }
    }

    @ReactMethod
    public void stop(Promise promise) {
        try {
            running = false;
            ServerSocket socket = serverSocket;
            serverSocket = null;
            if (socket != null) {
                try {
                    socket.close();
                } catch (Throwable ignored) {
                }
            }
            Thread thread = acceptThread;
            acceptThread = null;
            if (thread != null) thread.interrupt();
            promise.resolve(null);
        } catch (Throwable error) {
            promise.reject("lan_stop_failed", error);
        }
    }

    @ReactMethod
    public void getStatus(Promise promise) {
        try {
            promise.resolve(describe());
        } catch (Throwable error) {
            promise.reject("lan_status_failed", error);
        }
    }

    private WritableMap describe() {
        WritableMap map = Arguments.createMap();
        map.putBoolean("running", running);
        map.putString("token", token);
        String ip = localIp();
        int port = running && serverSocket != null ? serverSocket.getLocalPort() : 0;
        map.putString("ip", ip);
        map.putInt("port", port);
        map.putString("url", ip.isEmpty() || port == 0 ? "" : "http://" + ip + ":" + port + "/" + token);
        map.putString("dir", saveDir == null ? "" : saveDir.getAbsolutePath());
        WritableArray names = Arguments.createArray();
        File[] files = saveDir == null ? null : saveDir.listFiles();
        if (files != null) {
            for (File file : files) {
                if (file.isFile()) names.pushString(file.getName());
            }
        }
        map.putArray("files", names);
        return map;
    }

    private void acceptLoop(ServerSocket socket) {
        while (running && socket != null && !socket.isClosed()) {
            Socket client = null;
            try {
                client = socket.accept();
            } catch (Throwable ignored) {
                break;
            }
            final Socket target = client;
            Thread worker = new Thread(() -> handleClient(target), "yieyu-lanshare-client");
            worker.setDaemon(true);
            worker.start();
        }
    }

    private void handleClient(Socket socket) {
        if (socket == null) return;
        try {
            socket.setSoTimeout(120000);
            InputStream input = new BufferedInputStream(socket.getInputStream(), 16384);
            OutputStream output = new BufferedOutputStream(socket.getOutputStream(), 16384);
            String requestLine = readLine(input);
            if (requestLine == null || requestLine.isEmpty()) {
                closeQuietly(socket);
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                closeQuietly(socket);
                return;
            }
            String method = parts[0];
            String target = parts[1];
            Map<String, String> headers = new HashMap<>();
            String line;
            while (true) {
                line = readLine(input);
                if (line == null || line.isEmpty()) break;
                int index = line.indexOf(':');
                if (index > 0) {
                    headers.put(line.substring(0, index).trim().toLowerCase(Locale.US), line.substring(index + 1).trim());
                }
            }
            String query = "";
            String path = target;
            int mark = target.indexOf('?');
            if (mark >= 0) {
                path = target.substring(0, mark);
                query = target.substring(mark + 1);
            }
            if ("GET".equals(method) || "HEAD".equals(method)) {
                if (path.equals("/") || path.equals("/" + token) || path.equals("/index.html")) {
                    writeText(output, 200, "text/html; charset=utf-8", page());
                } else {
                    writeText(output, 404, "text/plain; charset=utf-8", "not found");
                }
            } else if ("PUT".equals(method) || "POST".equals(method)) {
                handleUpload(input, output, headers, query, path);
            } else {
                writeText(output, 405, "text/plain; charset=utf-8", "method not allowed");
            }
            try {
                output.flush();
            } catch (Throwable ignored) {
            }
            closeQuietly(socket);
        } catch (Throwable ignored) {
            closeQuietly(socket);
        }
    }

    private void handleUpload(InputStream input, OutputStream output, Map<String, String> headers, String query, String path) {
        try {
            if (!token.isEmpty() && !path.startsWith("/upload/" + token) && !path.startsWith("/" + token + "/upload")) {
                writeText(output, 403, "text/plain; charset=utf-8", "forbidden");
                return;
            }
            String name = param(query, "name");
            name = sanitize(name);
            long length = -1;
            String lengthHeader = headers.get("content-length");
            if (lengthHeader != null) {
                try {
                    length = Long.parseLong(lengthHeader.trim());
                } catch (Throwable ignored) {
                }
            }
            if (length <= 0) {
                writeText(output, 411, "text/plain; charset=utf-8", "content-length required");
                return;
            }
            if (length > MAX_UPLOAD) {
                writeText(output, 413, "text/plain; charset=utf-8", "too large");
                return;
            }
            if (name.isEmpty()) name = "upload-" + System.currentTimeMillis() + ".bin";
            File dir = saveDir != null ? saveDir : resolveSaveDir();
            if (dir == null) {
                writeText(output, 500, "text/plain; charset=utf-8", "no storage");
                return;
            }
            if (!dir.exists() && !dir.mkdirs() && !dir.exists()) {
                writeText(output, 500, "text/plain; charset=utf-8", "cannot create dir");
                return;
            }
            File target = uniqueFile(dir, name);
            FileOutputStream stream = null;
            long got = 0;
            boolean ok = false;
            try {
                stream = new FileOutputStream(target);
                byte[] buffer = new byte[65536];
                long remaining = length;
                while (remaining > 0 && running) {
                    int want = (int) Math.min(buffer.length, remaining);
                    int read = input.read(buffer, 0, want);
                    if (read <= 0) break;
                    stream.write(buffer, 0, read);
                    got += read;
                    remaining -= read;
                }
                stream.flush();
                ok = got == length;
            } catch (Throwable error) {
                ok = false;
            } finally {
                if (stream != null) {
                    try {
                        stream.close();
                    } catch (Throwable ignored) {
                    }
                }
            }
            if (!ok) {
                if (target.exists()) target.delete();
                writeText(output, 500, "text/plain; charset=utf-8", "upload failed");
                return;
            }
            writeText(output, 200, "application/json; charset=utf-8", "{\"ok\":true,\"name\":\"" + escape(target.getName()) + "\"}");
            emitUpload(target, got);
        } catch (Throwable error) {
            try {
                writeText(output, 500, "text/plain; charset=utf-8", "server error");
            } catch (Throwable ignored) {
            }
        }
    }

    private void emitUpload(File file, long size) {
        try {
            WritableMap map = Arguments.createMap();
            map.putString("name", file.getName());
            map.putString("path", file.getAbsolutePath());
            map.putDouble("size", (double) size);
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("YieyuLanShareUpload", map);
        } catch (Throwable ignored) {
        }
    }

    private String page() {
        try {
            InputStream stream = context.getResources().openRawResource(R.raw.lanshare_page);
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) > 0) buffer.write(chunk, 0, read);
            stream.close();
            String html = buffer.toString("UTF-8");
            return html.replace("%%TOKEN%%", token).replace("%%DIR%%", saveDir == null ? "" : saveDir.getAbsolutePath());
        } catch (Throwable error) {
            return "<html><body style=\"background:#111;color:#eee;font-family:sans-serif;padding:24px\">页面读取失败，请重启传歌服务</body></html>";
        }
    }

    private File resolveSaveDir() {
        try {
            File base = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            File dir = new File(base, "yieyu-import");
            if (dir.exists() || dir.mkdirs()) return dir;
        } catch (Throwable ignored) {
        }
        try {
            File ext = context.getExternalFilesDir("import");
            if (ext != null) {
                File dir = new File(ext, "lan");
                if (dir.exists() || dir.mkdirs()) return dir;
            }
            File internal = new File(context.getFilesDir(), "lan");
            if (internal.exists() || internal.mkdirs()) return internal;
        } catch (Throwable ignored) {
        }
        return null;
    }

    private String localIp() {
        try {
            List<String> candidates = new ArrayList<>();
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback()) continue;
                String name = network.getName().toLowerCase(Locale.US);
                if (!(name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("eth") || name.startsWith("rndis"))) continue;
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress()) candidates.add(address.getHostAddress());
                }
            }
            if (!candidates.isEmpty()) return candidates.get(0);
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback()) continue;
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress()) return address.getHostAddress();
                }
            }
        } catch (Throwable ignored) {
        }
        return "";
    }

    private static String newToken() {
        String chars = "abcdefghijkmnpqrstuvwxyz23456789";
        Random random = new Random();
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < 8; i++) builder.append(chars.charAt(random.nextInt(chars.length())));
        return builder.toString();
    }

    private static String sanitize(String name) {
        if (name == null) return "";
        String value = name.trim();
        int slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
        if (slash >= 0) value = value.substring(slash + 1);
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch < 32 || ch == ':' || ch == '*' || ch == '?' || ch == '"' || ch == '<' || ch == '>' || ch == '|') continue;
            builder.append(ch);
        }
        String cleaned = builder.toString().trim();
        if (cleaned.length() > 120) cleaned = cleaned.substring(0, 120);
        return cleaned;
    }

    private static File uniqueFile(File dir, String name) {
        File file = new File(dir, name);
        if (!file.exists()) return file;
        String base = name;
        String extension = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            base = name.substring(0, dot);
            extension = name.substring(dot);
        }
        for (int i = 1; i < 1000; i++) {
            File candidate = new File(dir, base + " (" + i + ")" + extension);
            if (!candidate.exists()) return candidate;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + extension);
    }

    private static String param(String query, String key) {
        if (query == null || query.isEmpty()) return "";
        for (String pair : query.split("&")) {
            int index = pair.indexOf('=');
            String name = index < 0 ? pair : pair.substring(0, index);
            if (!key.equals(name)) continue;
            String value = index < 0 ? "" : pair.substring(index + 1);
            try {
                return URLDecoder.decode(value, "UTF-8");
            } catch (UnsupportedEncodingException error) {
                return value;
            } catch (Throwable error) {
                return value;
            }
        }
        return "";
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) != -1) {
            if (value == '\n') break;
            if (value != '\r') buffer.write(value);
            if (buffer.size() > 8192) break;
        }
        if (value == -1 && buffer.size() == 0) return null;
        return buffer.toString("UTF-8");
    }

    private static void writeText(OutputStream output, int status, String contentType, String body) throws IOException {
        byte[] payload = body.getBytes("UTF-8");
        String head = "HTTP/1.1 " + status + " " + (status == 200 ? "OK" : "ERR") + "\r\n"
            + "Content-Type: " + contentType + "\r\n"
            + "Content-Length: " + payload.length + "\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n";
        output.write(head.getBytes("UTF-8"));
        output.write(payload);
    }

    private static String escape(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (Throwable ignored) {
        }
    }
}
