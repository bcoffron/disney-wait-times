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

const existingMatch=prompt.match(/JSONSTART(\[[\s\S]*?\])JSONEND/);
const existingSections=existingMatch?existingMatch[1]:null;

// Strip boilerplate walking times/rules â keep prompt lean
const cleanPrompt=prompt
  .replace(/You are an expert[^\n]*/i,'')
  .replace(/Walking times[\s\S]{0,500}/i,'')
  .replace(/Show positioning[\s\S]{0,300}/i,'')
  .replace(/DINING TIMING RULES[\s\S]{0,300}/i,'')
  .trim()
  .substring(0,2000);

const model="claude-sonnet-4-6";
const system='You are a Disneyland schedule optimizer. You MUST output ONLY a raw JSON object with zero additional text. Do not use markdown. Do not explain. Just JSON. Required structure: {"sections":[{"title":"Morning","entries":[{"t":"8:00 AM","h":"Ride Name","type":"ride","n":"short tip","land":"Land Name"}]}],"explanation":"one sentence summary"}';

const userMsg=existingSections
  ?"Optimize this schedule for minimum waits. JSON only, no other text.\nCurrent:"+existingSections.substring(0,6000)+"\nContext:"+cleanPrompt.substring(0,6000)
  :"Build an optimized day plan. JSON only, no other text.\n"+cleanPrompt;

function normalizeEntry(e){
  return{t:e.t||e.time||"",h:e.h||e.name||e.title||e.attraction||"",type:e.type||"ride",n:e.n||e.note||e.tip||e.description||"",land:e.land||""};
}

const anthropicRes=await fetch("https://api.anthropic.com/v1/messages",{
  method:"POST",
  headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
  body:JSON.stringify({model,max_tokens:4000,system,messages:[{role:"user",content:userMsg}]})
});
const data=await anthropicRes.json();

// Surface any Anthropic-level error
if(data.error){
  console.error("Anthropic error:",JSON.stringify(data.error));
  return res.status(500).json({error:data.error.message||JSON.stringify(data.error)});
}

console.log("model:",data.model,"stop:",data.stop_reason,"blocks:",(data.content||[]).map(b=>b.type).join(","));

let text="";
for(const block of(data.content||[])){
  if(block.type==="text")text+=block.text;
}

if(!text){
  console.error("No text blocks. stop_reason:",data.stop_reason,"content:",JSON.stringify(data.content||[]));
  return res.status(200).json({
    error:"Empty response from model",
    stop_reason:data.stop_reason,
    model:data.model,
    content_types:(data.content||[]).map(b=>b.type)
  });
}

// Robust JSON extraction â strip any accidental markdown
const clean=text.replace(/```json[\s\S]*?```/g,"").replace(/```/g,"").trim();

let parsed=null;
try{parsed=JSON.parse(clean);}
catch(e1){
  const m=clean.match(/\{[\s\S]+\}/);
  if(m)try{parsed=JSON.parse(m[0]);}catch(e2){
    const s=clean.indexOf('{'),e=clean.lastIndexOf('}');
    if(s>-1&&e>s)try{parsed=JSON.parse(clean.substring(s,e+1));}catch(e3){}
  }
}

// Fix truncation: if AI text doesn't end with ] try to close the array
if(!text.trim().endsWith(']')){
  const lastBrace=text.lastIndexOf('}');
  if(lastBrace>-1){
    const fixed=text.substring(0,lastBrace+1)+']';
    try{
      const tp=JSON.parse(fixed);
      if(Array.isArray(tp)){text=fixed;}
      else if(tp&&tp.sections){text=fixed;}
    }catch(ef){}
  }
}

if(parsed&&parsed.sections&&Array.isArray(parsed.sections)){
  const normalized=parsed.sections.map(s=>({title:s.title||"",entries:(s.entries||[]).map(normalizeEntry)}));
if(normalized.length<1)return res.status(200).json({error:'Schedule incomplete â please try again',sections:normalized});

// (safety check removed — was rejecting valid short schedules)
return res.status(200).json({sections:normalized,explanation:parsed.explanation||"Schedule optimized."});
}

console.error("Parse failed. clean:",clean.substring(0,200));
return res.status(200).json({error:"Parse failed",raw:clean.substring(0,600)});

}catch(e){
  console.error("Handler error:",e.message);
  return res.status(500).json({error:e.message});
}
}
handler.config={maxDuration:30};
module.exports=handler;
