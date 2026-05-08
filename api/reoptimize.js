async function handler(req,res){
res.setHeader("Access-Control-Allow-Origin","*");
res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers","Content-Type");
if(req.method==="OPTIONS")return res.status(200).end();
if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
try{
const{prompt,useWebSearch,apiKey:clientKey}=req.body;
const apiKey=process.env.ANTHROPIC_API_KEY||clientKey;
if(!apiKey)return res.status(500).json({error:"No API key"});
if(!prompt)return res.status(400).json({error:"Missing prompt"});

// Extract existing sections JSON from prompt (between JSONSTART[ and ]JSONEND)
const existingMatch=prompt.match(/JSONSTART(\[[\s\S]*?\])JSONEND/);
const existingSections=existingMatch?existingMatch[1]:null;

// Extract context clues from prompt (day, group size, date)
const dayMatch=prompt.match(/on ([^.]+\.)/)||["","Disneyland day"];

const tools=useWebSearch?[{type:"web_search_20250305",name:"web_search"}]:[];
const model=useWebSearch?"claude-sonnet-4-6":"claude-haiku-4-5-20251001";

const system="You are a Disneyland schedule optimizer. Return ONLY a JSON object with no explanation outside JSON. Format exactly: {\"sections\":[{\"title\":\"string\",\"entries\":[{\"t\":\"H:MM AM/PM\",\"h\":\"Attraction Name\",\"type\":\"ride|show|dining|break|tip\",\"n\":\"brief tip\",\"land\":\"Land Name\"}]}],\"explanation\":\"one sentence max\"}";

const userMsg=existingSections
?"Optimize this Disneyland schedule for minimum waits. Return improved version as JSON.\n\nCurrent schedule:\n"+existingSections+"\n\nContext from planner:\n"+prompt.replace(/JSONSTART[\s\S]*?JSONEND/,"").substring(0,800)
:prompt.substring(0,1500);

function normalizeEntry(e){
return{t:e.t||e.time||"",h:e.h||e.name||e.title||e.attraction||"",type:e.type||"ride",n:e.n||e.note||e.tip||e.description||"",land:e.land||""};
}

const r=await fetch("https://api.anthropic.com/v1/messages",{
method:"POST",
headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
body:JSON.stringify({model,max_tokens:2000,system,tools,messages:[{role:"user",content:userMsg}]})
});
const data=await r.json();
if(data.error)return res.status(500).json({error:data.error});
let text="";
for(const block of(data.content||[]))if(block.type==="text")text+=block.text;
const clean=text.replace(/```json|```/g,"").trim();

// Try to parse JSON
let parsed=null;
try{parsed=JSON.parse(clean);}catch(e){
const m=clean.match(/\{[\s\S]+\}/);
if(m)try{parsed=JSON.parse(m[0]);}catch(e2){}
}

if(parsed&&parsed.sections&&Array.isArray(parsed.sections)){
const normalized=parsed.sections.map(function(s){return{title:s.title||"",entries:(s.entries||[]).map(normalizeEntry)};});
return res.status(200).json({sections:normalized,explanation:parsed.explanation||"Schedule optimized."});
}
return res.status(200).json({error:"Parse failed",raw:text.substring(0,400)});

}catch(e){
return res.status(500).json({error:e.message});
}
}
handler.config={maxDuration:60};
module.exports=handler;