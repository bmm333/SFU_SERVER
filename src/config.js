const path = require('path');

require('dotenv').config();

const config = {
    server: {
        port: parseInt(process.env.SFU_PORT) || 3001,
        nodeEnv: process.env.NODE_ENV || 'development',
        logLevel: process.env.LOG_LEVEL || 'info'
    },
    mediasoup: {
        worker: {
            rtcMinPort: parseInt(process.env.RTC_MIN_PORT) || 40000,
            rtcMaxPort: parseInt(process.env.RTC_MAX_PORT) || 49999,
            logLevel: process.env.MEDIASOUP_WORKER_SETTINGS_LOGLEVEL || 'warn',
            logTags: process.env.MEDIASOUP_WORKER_SETTINGS_LOGTAGS?.split(',') || [
                'info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'
            ]
        },
        router: {
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000
                },
                {
                    kind: 'video',
                    mimeType: 'video/h264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '42e01f',
                        'level-asymmetry-allowed': 1
                    }
                }
            ]
        },
        webRtcTransport: {
            listenIps: [
                {
                    ip: process.env.LISTEN_IP || '0.0.0.0',
                    announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1'
                }
            ],
            enableUdp: process.env.WEBRTC_TRANSPORT_ENABLE_UDP === 'true',
            enableTcp: process.env.WEBRTC_TRANSPORT_ENABLE_TCP === 'true',
            preferUdp: process.env.WEBRTC_TRANSPORT_PREFER_UDP === 'true',
            initialAvailableOutgoingBitrate: parseInt(
                process.env.WEBRTC_TRANSPORT_INITIAL_AVAILABLE_OUTGOING_BITRATE
            ) || 1000000
        }
    },
    network: {
        wsPath: process.env.WS_PATH || '/sfu',
        maxConnections: parseInt(process.env.WS_MAX_CONNECTIONS) || 1000,
        corsOrigin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5502']
    },
    ssl: {
        enabled: process.env.SSL_ENABLED === 'true',
        certPath: process.env.SSL_CERT_PATH || path.join(__dirname, '../certs/cert.pem'),
        keyPath: process.env.SSL_KEY_PATH || path.join(__dirname, '../certs/key.pem')
    },
    acadex: {
        backendUrl: process.env.ACADEX_BACKEND_URL || 'http://localhost:3000',
        backendWsUrl: process.env.ACADEX_BACKEND_WS_URL || 'ws://localhost:3000',
        apiKey: process.env.ACADEX_API_KEY || '',
        jwtSecret: process.env.JWT_SECRET || 'your-jwt-secret'
    },
    performance: {
        maxSessions: parseInt(process.env.MAX_SESSIONS) || 100,
        maxParticipantsPerSession: parseInt(process.env.MAX_PARTICIPANTS_PER_SESSION) || 50,
        sessionTimeout: parseInt(process.env.SESSION_TIMEOUT) || 3600000,
        maxBitrateVideo: parseInt(process.env.MAX_BITRATE_VIDEO) || 2000000,
        maxBitrateAudio: parseInt(process.env.MAX_BITRATE_AUDIO) || 128000,
        maxFramerate: parseInt(process.env.MAX_FRAMERATE) || 30
    },

    healthCheck: {
        enabled: true,
        interval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 30000,
        port: parseInt(process.env.HEALTH_CHECK_PORT) || 3002
    },

    metrics: {
        enabled: process.env.ENABLE_METRICS === 'true',
        port: parseInt(process.env.METRICS_PORT) || 3003,
        path: process.env.METRICS_PATH || '/metrics'
    },

    development: {
        debugEnabled: process.env.DEBUG_ENABLED === 'true',
        hotReload: process.env.HOT_RELOAD === 'true',
        enableWebsocketLogging: process.env.ENABLE_WEBSOCKET_LOGGING === 'true'
    }
};

module.exports = config;