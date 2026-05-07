async function handler(req,res){
res.setHeader("Access-Control-Allow-Origin","*");
res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers","Content-Type");
if(req.method==="OPTIONS")return res.status(200).end();
if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
try{
const{prompt,systemPrompt,useWebSearch,apiKey:clientKey}=req.body;
const apiKey=process.env.ANTHROPIC_API_KEY||clientKey;
if(!apiKey)return res.status(500).json({error:"No API key"});
if(!prompt)return res.status(400).json({error:"Missing prompt"});
const tools=useWebSearch?[{type:"web_search_20250305",name:"web_search"}]:[];
const r=await fetch("https://api.anthropic.com/v1/messages",{
method:"POST",
headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:4000,system:systemPrompt||"You are an expert Disneyland touring planner.",tools:tools,messages:[{role:"user",content:prompt}]})
});
const data=await r.json();
if(data.error)return res.status(500).json({error:data.error});
let text="";
for(const block of(data.content||[]))if(block.type==="text")text+=block.text;
const jm=text.match(/JSONSTART([\s\S]+?)JSONEND/);
const sm=text.match(/SUMMARY:\s*(.+)/);
if(jm){try{const sections=JSON.parse(jm[1].trim());return res.status(200).json({sections,explanation:sm?sm[1].trim():""});}catch(e){return res.status(200).json({raw:text});}}
return res.status(200).json({raw:text});
}catch(e){return res.status(500).json({error:e.message});}
}
handler.config={maxDuration:60};
module.exports=handler;