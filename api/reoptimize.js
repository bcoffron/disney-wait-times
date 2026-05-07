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
const model=useWebSearch?"claude-sonnet-4-6":"claude-haiku-4-5-20251001";

function normalizeEntry(e){
return{t:e.t||e.time||"",h:e.h||e.name||e.title||e.attraction||"",type:e.type||"ride",n:e.n||e.note||e.tip||e.description||"",land:e.land||""};
}

const r=await fetch("https://api.anthropic.com/v1/messages",{
method:"POST",
headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
body:JSON.stringify({model,max_tokens:2000,system:systemPrompt,tools,messages:[{role:"user",content:prompt}]})
});
const data=await r.json();
if(data.error)return res.status(500).json({error:data.error});
let text="";
for(const block of(data.content||[]))if(block.type==="text")text+=block.text;

// Try JSONSTART/JSONEND first (what app requests)
const jm=text.match(/JSONSTART([\s\S]*?)JSONEND/);
if(jm){
try{
const sections=JSON.parse(jm[1].trim());
const sm=text.match(/SUMMARY:\s*(.+)/);
const normalized=sections.map(function(s){return{title:s.title||"",entries:(s.entries||[]).map(normalizeEntry)};});
return res.status(200).json({sections:normalized,explanation:sm?sm[1].trim():"Schedule optimized."});
}catch(e){
return res.status(200).json({error:"JSON parse failed",raw:text.substring(0,500)});
}
}

// Fallback: try plain JSON object
const clean=text.replace(/```json|```/g,"").trim();
const m=clean.match(/\{[\s\S]+\}/);
if(m){
try{
const p=JSON.parse(m[0]);
if(p.sections){
const normalized=p.sections.map(function(s){return{title:s.title||"",entries:(s.entries||[]).map(normalizeEntry)};});
return res.status(200).json({sections:normalized,explanation:p.explanation||"Schedule optimized."});
}
}catch(e2){}
}

// Return raw so client can see what went wrong
return res.status(200).json({error:"Parse failed",raw:text.substring(0,500)});

}catch(e){
return res.status(500).json({error:e.message});
}
}
handler.config={maxDuration:60};
module.exports=handler;