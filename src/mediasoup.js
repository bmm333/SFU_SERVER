const mediasoup=require("mediasoup");
let worker;
let router;

async function createWorker(){
    worker=await mediasoup.createWorker({
        rtcMinPort: 40000,
        rtcMaxPort: 49999
    });
    worker.on("died",()=>{
        console.error("Mediasoup wroker died,exiting ...");
        process.exit(1);
    });
    router = await worker.createRouter({
        mediaCodecs:[
            {kind:"audio",mimeType:"audio/opus",clockRate:48000,channels:2},
            {kind:"video",mimeType:"video/VP8",clockRate:90000},
        ],
    });
    return {worker,router};
}
function getRouter()
{
    if(!router)throw new Error("Router is not initalized");
    return router;
}
module.exports={createWorker,getRouter};