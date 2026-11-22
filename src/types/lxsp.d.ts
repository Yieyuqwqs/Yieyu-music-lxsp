/**
 * LXSP · LX Source Protocol v2
 * 落雪音乐统一音源协议（线格式 / wire format）
 *
 * 这份声明只描述「网络上长什么样」，不含客户端实现细节。
 * 任何实现（Rust 网关 / Node 参考实现 / 第三方后端）只要满足本文件 + docs/LXSP-v2.md，
 * 即为合规音源提供方（Provider），不需要再写一行 JS 脚本。
 *
 * 约定：
 * - 所有响应都是 JSON，UTF-8，统一信封（Envelope）。
 * - 未知字段必须被忽略（前向兼容），未知能力必须被跳过（能力降级）。
 * - 音质 / 音源 / 错误码是封闭词汇表，服务端不得自创别名（见 quality alias 表）。
 */
declare namespace LX {
  namespace Lxsp {
    /** 协议版本：只接受 2.x，主版本不同即不兼容 */
    type Version = `2.${number}`

    /** 音源键：必须落在 LX 词汇表内 */
    type SourceKey = LX.Source

    /** 能力名：声明即承诺，未声明即不调用 */
    type Capability = 'search' | 'url' | 'lyric' | 'pic' | 'playlist' | 'chart' | 'stream'

    /** 音质：沿用 LX 规范词汇，服务端自有词汇（sq/hq/lossless）必须先按 alias 表归一 */
    type Quality = LX.QualityLevel

    /**
     * 错误码封闭集合：客户端行为只由错误码决定，
     * 不允许由 HTTP 状态码或文案去猜。
     */
    type ErrorCode =
      | 'unsupported'          // 该能力/音源未实现
      | 'not_found'            // 上游确认无此曲 / id 无效
      | 'quality_unavailable'  // 该档音质不可得（可降档）
      | 'upstream_denied'      // 版权/VIP/地区/风控拒绝（降档通常无效）
      | 'upstream_error'       // 上游 5xx / 解析失败（可重试）
      | 'rate_limited'         // 被限流（退避重试）
      | 'unauthorized'         // 提供方鉴权失败（换源无效，需改配置）
      | 'timeout'              // 超时（换镜像）
      | 'network'              // 连接类错误（换镜像）
      | 'bad_request'          // 客户端参数不合法
      | 'bad_response'         // 响应不符合协议（不重试，换镜像）
      | 'canceled'             // 客户端主动取消
      | 'internal'             // 服务端内部错误（可重试一次）

    /** 统一信封 */
    interface Envelope<T> {
      ok: boolean
      data?: T
      error?: ErrorBody
      /** 服务端追踪号，用于日志对齐 */
      trace?: string
    }

    interface ErrorBody {
      code: ErrorCode
      /** 人类可读，仅用于展示/日志，客户端不得据此判断逻辑 */
      message: string
      retryable?: boolean
      /** rate_limited 时的建议等待毫秒 */
      retryAfterMs?: number
      source?: SourceKey
      /** 出错时正在尝试的音质，供客户端决定是否降档 */
      quality?: Quality
      /** 上游原始错误，调试用，不驱动逻辑 */
      upstream?: string
    }

    /** 音质细节；size 为字节，null 表示未知 */
    interface QualityDetail {
      size?: number | null
      bitrateKbps?: number | null
      sampleRate?: number | null
      bitDepth?: number | null
      /** 容器/编码：mp3 / flac / m4a / wav / ape */
      format?: string | null
    }

    /** 归一化曲目（搜索结果 / 歌单 / 榜单通用） */
    interface Track {
      /** 提供方内曲目 id，字符串，客户端原样回传 */
      id: string
      name: string
      /** 多歌手统一用 、 分隔（与 LX 现有数据模型一致） */
      singer: string
      album?: string
      /** 毫秒 */
      durationMs?: number | null
      coverUrl?: string | null
      qualities?: Partial<Record<Quality, QualityDetail>>
      /**
       * 不透明透传字段：客户端不解释、只回传。
       * 严禁把任何凭证放进 extra（会被写进播放历史）。
       */
      extra?: Record<string, string>
    }

    interface SourceDecl {
      key: SourceKey
      /** 展示名，如「酷我音乐」 */
      name: string
      /** 该音源支持的全部音质（顺序无关，客户端按规范阶梯排序） */
      qualities: Quality[]
      /** 实际实现的能力；缺省继承 manifest.capabilities */
      capabilities?: Capability[]
      idFormat?: 'string' | 'uint'
      note?: string
    }

    /** 路由覆盖：允许后端把能力挂在别的路径上 */
    type EndpointKey = 'search' | 'url' | 'lyric' | 'pic' | 'playlist' | 'chart' | 'stream' | 'health'

    interface Manifest {
      lxsp: Version
      provider: {
        /** 提供方唯一 id：同一提供方的多个镜像必须相同 */
        id: string
        name: string
        version: string
        homepage?: string
        license?: string
      }
      sources: SourceDecl[]
      capabilities?: Capability[]
      auth?: {
        required: boolean
        /** bearer: Authorization: Bearer <t>；header: 自定义头；query: 查询参数 */
        scheme?: 'bearer' | 'header' | 'query'
        header?: string
        query?: string
      }
      /** 声明限制；客户端取 min(本地, 声明) */
      limits?: {
        timeoutMs?: number
        maxPageSize?: number
        /** 媒体直链有效期（秒），缺省视为未知 */
        urlTtlS?: number
      }
      endpoints?: Partial<Record<EndpointKey, string>>
      features?: {
        streamProxy?: boolean
        /** /url 是否支持 fallback=1 跨平台兜底 */
        crossSource?: boolean
        /** /search 是否支持 sources= 聚合 */
        multiSource?: boolean
      }
      meta?: Record<string, unknown>
    }

    /** GET /url/{source}/{id}?quality=&name=&singer=&album=&duration=&fallback= */
    interface UrlRequest {
      source: SourceKey
      id: string
      quality?: Quality | 'auto'
      name?: string
      singer?: string
      album?: string
      /** 毫秒 */
      duration?: number
      fallback?: 0 | 1
    }

    interface UrlData {
      /** 直链；features.streamProxy 为真时优先用 streamUrl */
      url: string
      source: SourceKey
      id: string
      /** 实际给出的音质 */
      quality: Quality
      /** 请求音质回显 */
      requestedQuality: Quality | 'auto'
      /** 是否降档：必须显式声明，禁止静默降级 */
      downgraded: boolean
      expiresAt?: string | number
      /** 代理流地址（含 token），客户端优先使用 */
      streamUrl?: string
      detail?: QualityDetail
      extra?: Record<string, string>
      via?: {
        upstream?: string
        cache?: 'l1' | 'l2' | 'upstream'
        coalesced?: boolean
      }
    }

    /** GET /lyric/{source}/{id} */
    interface LyricData {
      lrc: string
      tlrc?: string | null
      rlrc?: string | null
      /** 逐字歌词（LRC 文本 + 富标签，或 yrc/krc 转出的 LRC） */
      lxlrc?: string | null
      format?: 'lrc' | 'krc' | 'qrc' | 'yrc' | 'plain' | string
      translatedBy?: 'manual' | 'machine' | null
      offsetMs?: number | null
    }

    /** GET /pic/{source}/{id}?size= */
    interface PicData {
      url: string
      width?: number | null
      height?: number | null
      format?: string | null
    }

    /** GET /search?q=&sources=&page=&limit= */
    interface SearchData {
      items: Track[]
      page: number
      limit: number
      total?: number | null
      hasMore: boolean
      sources?: SourceKey[]
    }

    /** GET /playlist/{source}/{id}、GET /chart/{source}/{id} */
    interface CollectionData {
      id: string
      name: string
      coverUrl?: string | null
      description?: string | null
      author?: string | null
      items: Track[]
      page?: number
      hasMore?: boolean
    }

    /** GET /healthz */
    interface HealthData {
      status: 'ok' | 'degraded' | 'down'
      version?: string
      sources?: Partial<Record<SourceKey, 'ok' | 'degraded' | 'down'>>
      uptimeS?: number
    }
  }
}
