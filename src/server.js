const { createWorker } = require('./mediasoup');
const config = require('./config');
const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

class SFUServer {
    constructor() {
        this.clients = new Map();
        this.sessions = new Map();
        this.transports = new Map();
        this.producers = new Map();
        this.consumers = new Map();
        this.router = null;
    }

    async initialize() {
        try {
            const { router } = await createWorker();
            this.router = router;
            
            // HTTPS server for WebSocket (required for WebRTC)
            const server = https.createServer({
                cert: fs.readFileSync(config.ssl.certPath),
                key: fs.readFileSync(config.ssl.keyPath)
            });
            
            this.wss = new WebSocket.Server({
                server,
                path: config.network.wsPath
            });
            
            this.setupWebSocketHandlers();
            
            server.listen(config.server.port, () => {
                console.log(`SFU Server running on port ${config.server.port}`);
                console.log(`Environment: ${config.server.nodeEnv}`);
                console.log(`Announced IP: ${config.mediasoup.webRtcTransport.listenIps[0].announcedIp}`);
            });
            
        } catch (error) {
            console.error('Failed to initialize SFU server:', error);
            process.exit(1);
        }
    }
    setupWebSocketHandlers() {
        this.wss.on('connection', (ws) => {
            console.log('New client connected');
            
            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleMessage(ws, data);
                } catch (error) {
                    console.error('Message handling error:', error);
                    this.sendError(ws, 'Invalid message format');
                }
            });

            ws.on('close', () => {
                this.handleClientDisconnect(ws);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
            });
        });
    }

    async handleMessage(ws,data)
    {
        const {type,payload}=data;
        switch(type)
        {
            case'join':
                await this.handleJoin(ws,payload);
                break;
            case 'createTransport':
                await this.handleCreateTransport(ws,payload);
                break;
            case 'connectTransport':
                await this.handleConnectTransport(ws,payload);
                break;
            case 'produce':
                await this.handleProduce(ws,payload);
                break;
            case 'consume':
                await this.handleConsume(ws,payload);
                break;
            case 'resume':
                await this.handleResume(ws, payload);
                break;
            case 'pause':
                await this.handlePause(ws, payload);
                break;
            case 'close':
                await this.handleClose(ws, payload);
                break;
            default:
                this.sendError(ws, `Unknown message type: ${type}`);
        }
    }
    async handleJoin(ws,payload)
    {
        const {sessionId,userId,userInfo}=payload;
        try{
            const clientId=this.generateClientId();
            ws.clientId=clientId;
            this.clients.set(clientId,{
                id:clientId,
                ws,
                sessionId,
                userId,
                userInfo,
                transports: new Set(),
                producers: new Set(), 
                consumers: new Set()
            });
            if(!this.sessions.has(sessionId)) {
                this.sessions.set(sessionId,{
                    id:sessionId,
                    clients:new Set(),
                    producers:new Set()
                });
            }
            const session=this.sessions.get(sessionId);
            session.clients.add(clientId);
            this.sendMessage(ws,'routerRtpCapabilities',{
                rtpCapabilities: this.router.rtpCapabilities
            });
            console.log(`Client ${userId} joined session ${sessionId}`);
        }catch(error){
            console.error('Join error:',error);
            this.sendError(ws,'Failed to join session');
        }
    }
    async handleCreateTransport(ws,payload)
    {
        const{direction}=payload; //either send or recv
        const client=this.clients.get(ws.clientId);

        if(!client)
        {
            return this.sendError(ws,'Client not found');
        }
        try{
            const transport=await this.router.createWebRtcTransport({
                listenIps:[
                    { ip: '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1' }
                ],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                enableSctp: direction==='send'
            });
            this.transports.set(transport.id,{
                transport,
                clientId:ws.clientId,
                direction
            });
            client.transports.add(transport.id);
            transport.on('dtlsstatechange', (dtlsState) => {
                if (dtlsState === 'closed') {
                    this.cleanupTransport(transport.id);
                }
            });
            this.sendMessage(ws, 'transportCreated', {
                transportId: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
                sctpParameters: transport.sctpParameters
            });
        }catch(error)
        {
            console.error('Create transport error: ',error);
            this.sendError(ws,'Failed to create transport');
        }
    }
    async handleConnectTransport(ws, payload) {
        const { transportId, dtlsParameters } = payload;
        const transportData = this.transports.get(transportId);
        
        if (!transportData) {
            return this.sendError(ws, 'Transport not found');
        }

        try {
            await transportData.transport.connect({ dtlsParameters });
            this.sendMessage(ws, 'transportConnected', { transportId });
        } catch (error) {
            console.error('Connect transport error:', error);
            this.sendError(ws, 'Failed to connect transport');
        }
    }

    async handleProduce(ws, payload) {
        const { transportId, kind, rtpParameters, appData } = payload;
        const client = this.clients.get(ws.clientId);
        const transportData = this.transports.get(transportId);
        
        if (!client || !transportData) {
            return this.sendError(ws, 'Client or transport not found');
        }

        try {
            const producer = await transportData.transport.produce({
                kind,
                rtpParameters,
                appData: { ...appData, clientId: ws.clientId, userId: client.userId }
            });

            this.producers.set(producer.id, {
                producer,
                clientId: ws.clientId,
                kind,
                sessionId: client.sessionId
            });

            client.producers.add(producer.id);

            // Add to session producers
            const session = this.sessions.get(client.sessionId);
            session.producers.add(producer.id);

            producer.on('transportclose', () => {
                this.cleanupProducer(producer.id);
            });

            this.sendMessage(ws, 'produced', { 
                producerId: producer.id,
                kind 
            });

            // Notify other clients in session about new producer
            this.notifyNewProducer(client.sessionId, producer.id, client.userId, kind, ws.clientId);

        } catch (error) {
            console.error('Produce error:', error);
            this.sendError(ws, 'Failed to produce');
        }
    }

    async handleConsume(ws, payload) {
        const { transportId, producerId, rtpCapabilities } = payload;
        const client = this.clients.get(ws.clientId);
        const transportData = this.transports.get(transportId);
        const producerData = this.producers.get(producerId);
        
        if (!client || !transportData || !producerData) {
            return this.sendError(ws, 'Client, transport, or producer not found');
        }

        try {
            // Check if router can consume
            if (!this.router.canConsume({
                producerId,
                rtpCapabilities
            })) {
                return this.sendError(ws, 'Cannot consume');
            }

            const consumer = await transportData.transport.consume({
                producerId,
                rtpCapabilities,
                paused: true // Start paused
            });

            this.consumers.set(consumer.id, {
                consumer,
                clientId: ws.clientId,
                producerId
            });

            client.consumers.add(consumer.id);

            consumer.on('transportclose', () => {
                this.cleanupConsumer(consumer.id);
            });

            consumer.on('producerclose', () => {
                this.cleanupConsumer(consumer.id);
                this.sendMessage(ws, 'consumerClosed', { consumerId: consumer.id });
            });

            this.sendMessage(ws, 'consumed', {
                consumerId: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                paused: consumer.paused
            });

        } catch (error) {
            console.error('Consume error:', error);
            this.sendError(ws, 'Failed to consume');
        }
    }

    async handleResume(ws, payload) {
        const { consumerId } = payload;
        const consumerData = this.consumers.get(consumerId);
        
        if (!consumerData || consumerData.clientId !== ws.clientId) {
            return this.sendError(ws, 'Consumer not found');
        }

        try {
            await consumerData.consumer.resume();
            this.sendMessage(ws, 'resumed', { consumerId });
        } catch (error) {
            console.error('Resume error:', error);
            this.sendError(ws, 'Failed to resume consumer');
        }
    }

    async handlePause(ws, payload) {
        const { consumerId, producerId } = payload;
        
        if (consumerId) {
            const consumerData = this.consumers.get(consumerId);
            if (consumerData && consumerData.clientId === ws.clientId) {
                try {
                    await consumerData.consumer.pause();
                    this.sendMessage(ws, 'paused', { consumerId });
                } catch (error) {
                    this.sendError(ws, 'Failed to pause consumer');
                }
            }
        }
        
        if (producerId) {
            const producerData = this.producers.get(producerId);
            if (producerData && producerData.clientId === ws.clientId) {
                try {
                    await producerData.producer.pause();
                    this.sendMessage(ws, 'paused', { producerId });
                    this.notifyProducerPaused(producerData.sessionId, producerId, ws.clientId);
                } catch (error) {
                    this.sendError(ws, 'Failed to pause producer');
                }
            }
        }
    }

    async handleClose(ws, payload) {
        const { consumerId, producerId } = payload;
        
        if (consumerId) {
            this.cleanupConsumer(consumerId);
        }
        
        if (producerId) {
            this.cleanupProducer(producerId);
        }
    }

    notifyNewProducer(sessionId, producerId, userId, kind, excludeClientId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        for (const clientId of session.clients) {
            if (clientId !== excludeClientId) {
                const client = this.clients.get(clientId);
                if (client) {
                    this.sendMessage(client.ws, 'newProducer', {
                        producerId,
                        userId,
                        kind
                    });
                }
            }
        }
    }

    notifyProducerPaused(sessionId, producerId, excludeClientId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        for (const clientId of session.clients) {
            if (clientId !== excludeClientId) {
                const client = this.clients.get(clientId);
                if (client) {
                    this.sendMessage(client.ws, 'producerPaused', { producerId });
                }
            }
        }
    }

    notifyProducerClosed(sessionId, producerId, excludeClientId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        for (const clientId of session.clients) {
            if (clientId !== excludeClientId) {
                const client = this.clients.get(clientId);
                if (client) {
                    this.sendMessage(client.ws, 'producerClosed', { producerId });
                }
            }
        }
    }

    // Cleanup methods
    cleanupProducer(producerId) {
        const producerData = this.producers.get(producerId);
        if (producerData) {
            producerData.producer.close();
            
            // Remove from session
            const session = this.sessions.get(producerData.sessionId);
            if (session) {
                session.producers.delete(producerId);
            }
            
            // Remove from client
            const client = this.clients.get(producerData.clientId);
            if (client) {
                client.producers.delete(producerId);
            }
            
            this.producers.delete(producerId);
            
            // Notify other clients
            this.notifyProducerClosed(producerData.sessionId, producerId, producerData.clientId);
        }
    }

    cleanupConsumer(consumerId) {
        const consumerData = this.consumers.get(consumerId);
        if (consumerData) {
            consumerData.consumer.close();
            
            // Remove from client
            const client = this.clients.get(consumerData.clientId);
            if (client) {
                client.consumers.delete(consumerId);
            }
            
            this.consumers.delete(consumerId);
        }
    }
    /*going to add other handles but closing for now need to overview acadex backend.. Done */
    generateClientId() {
        return Math.random().toString(36).substr(2, 9);
    }

    sendMessage(ws, type, payload) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, payload }));
        }
    }

    sendError(ws, error) {
        this.sendMessage(ws, 'error', { error });
    }

    handleClientDisconnect(ws) {
        const clientId = ws.clientId;
        if (!clientId) return;

        const client = this.clients.get(clientId);
        if (client) {
            this.cleanupClient(clientId);
            console.log(`Client ${client.userId} disconnected`);
        }
    }

    cleanupClient(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;

        for (const transportId of client.transports) {
            this.cleanupTransport(transportId);
        }
        const session = this.sessions.get(client.sessionId);
        if (session) {
            session.clients.delete(clientId);
            if (session.clients.size === 0) {
                this.sessions.delete(client.sessionId);
            }
        }

        this.clients.delete(clientId);
    }

    cleanupTransport(transportId) {
        const transportData = this.transports.get(transportId);
        if (transportData) {
            transportData.transport.close();
            this.transports.delete(transportId);
        }
    }
}

const sfuServer = new SFUServer();
sfuServer.initialize().catch(console.error);

module.exports = SFUServer;