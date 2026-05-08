async function handler(req,res){
res.setHeader("Access-Control-Allow-Origin","*");
res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers","Content-Type");
if(req.method==="OPTIONS")return res.status(200).end();
if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
try{
const{prompt,apiKey:clientKey}=req.body;
const apiKey=process.env.ANTHROPIC_API_KEY||clientKey;
if(!apiKey)return res.status(500).json({error:"No API key"});
if(!prompt)return res.status(400).json({error:"Missing prompt"});

const existingMatch=prompt.match(/JSONSTART(\[\s\S]*?\])JSONEND/);
const existingSections=existingMatch?existingMatch[1]:null;

// Strip boilerplate to keep prompt short and fast
const cleanPrompt=prompt
  .replace(/You are an expert[^\n]*/i,'')
  .replace(/Walking times[\s\S]{0,400}/i,'')
  .replace(/Show positioning[\s\S]{0,200}/i,'')
  .replace(/DINING TIMING RULES[\s\S]{0,200}/i,'')
  .trim()
  .substring(0,600);

const model="claude-sonnet-4-6";
const system='Disneyland schedule optimizer. Output ONLY a raw JSON object — absolutely no prose, no markdown, no backticks. Structure: {"sections":[{"title":"string","entries":[{"t":"H:MM AM/PM","h":"name","type":"ride|show|dining|break|tip","n":"tip","land":"land"}]}],"explanation":"one sentence"}';

const userMsg=existingSections
?"Optimize for min waits. Return JSON only.\nSchedule:"+existingSections+"\nContext:"+cleanPrompt
:"Optimized Disneyland schedule for this group. Return JSON only.\n"+cleanPrompt;

function normalizeEntry(e){
return{t:e.t||e.time||"",h:e.h||e.name||e.title||e.attraction||"",type:e.type||"ride",n:e.n||e.note||e.tip||e.description||"",land:e.land||""};
}

const r=await fetch("https://api.anthropic.com/v1/messages",{
method:"POST",
headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
body:JSON.stringify({model,max_tokens:2000,system,messages:[{role:"user",content:userMsg}]})
});
const data=await r.json();
if(data.error)return res.status(500).json({error:data.error.message||JSON.stringify(data.error)});
let text="";
for(const block of(data.content||[]))if(block.type==="text")text+=block.text;
if(!text)return res.status(500).json({error:"Empty response",stop_reason:data.stop_reason,model:data.model});

const clean=text.replace(/```json[\s\S]*?```/g,"").replace(/```/g,"").trim();
let parsed=null;
try{parsed=JSON.parse(clean);}catch(e1){
const m=clean.match(/\{[\s\S]+\}/);
if(m)try{parsed=JSON.parse(m[0]);}catch(e2){
const s=clean.indexOf('{'),e=clean.lastIndexOf('}');
if(s>-1&&e>s)try{parsed=JSON.parse(clean.substring(s,e+1));}catch(e3){}
}
}

if(parsed&&parsed.sections&&Array.isArray(parsed.sections)){
const normalized=parsed.sections.map(function(s){return{title:s.title||"",entries:(s.entries||[]).map(normalizeEntry)};});
return res.status(200).json({sections:normalized,explanation:parsed.explanation||"Schedule optimized."});
}
return res.status(200).json({error:"Parse failed",raw:clean.substring(0,600)});

}catch(e){
return res.status(500).json({error:e.message});
}
}
handler.config={maxDuration:30};
module.exports=handler;