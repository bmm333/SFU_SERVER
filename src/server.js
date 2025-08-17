const { createWorker } = require("mediasoup");

class SFUServer{
    constructor()
    {this.clients=new Map();
    this.sessions=new Map();
    this.transports=new Map();
    this.producers=new Map();
    this.consumers=new Map();
    this.router=null;
    }
    async initalize()
    {
        try{
            const {router}=await createWorker();
            this.router=router;
            //Https server for Ws (for webrtc)
            const server=https.createServer({
                cert:fs.readFileSync(path.join(__dirname,'../certs/cert.pem')),
                key:fs.readFileSync(path.join(__dirname,'../certs/key.pem'))
            });
            this.wss=new WebSocket.Server({
                server,
                path:'/sfu'
            });
            this.setupWebSocketHandlers();
            const port=process.env.SFU_PORT||3001;
            server.listen(port,()=>{
                console.log(`SFU Server running on port ${port}`);
            })
        }catch(error)
        {
            console.error('Failed to initialize SFU server: ',error);
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
            case 'createTrasport':
                await this.handleCreateTrasport(ws,payload);
                break;
            case 'connectTrasport':
                await this.handleConnectTrasport(ws,payload);
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
                trasports:new Set(),
                produces:new Set(),
                consumers:new Set()
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
    async handleCreateTrasport(ws,payload)
    {
        const{direction}=payload; //either send or rcv
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
            this.transports.set(trasport.id,{
                transport,
                clientId:ws.clientId,
                direction
            });
            client.transport.add(transport.id);
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
            this.sendError(ws,'Failed to create trasport');
        }
    }
    /*going to add other handles but closing for now need to overview acadex backend */
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