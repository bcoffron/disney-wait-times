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

// Override system prompt to use pure JSON output (more reliable than JSONSTART/JSONEND)
const jsonSystemPrompt="You are a Disneyland schedule optimizer. Return ONLY a valid JSON object with no markdown, no explanation outside JSON. Format: {\"sections\":[{\"title\":\"string\",\"entries\":[{\"t\":\"H:MM AM/PM\",\"name\":\"string\",\"type\":\"ride|show|dining|break\",\"note\":\"string\",\"land\":\"string\",\"h\":\"string\"}]}],\"explanation\":\"max 20 words on biggest change\"}";

const r=await fetch("https://api.anthropic.com/v1/messages",{
method:"POST",
headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01"},
body:JSON.stringify({model,max_tokens:2000,system:jsonSystemPrompt,tools,messages:[{role:"user",content:prompt}]})
});
const data=await r.json();
if(data.error)return res.status(500).json({error:data.error});
let text="";
for(const block of(data.content||[]))if(block.type==="text")text+=block.text;
text=text.replace(/```json|```/g,"").trim();
try{
const parsed=JSON.parse(text);
if(parsed.sections&&Array.isArray(parsed.sections)){
return res.status(200).json({sections:parsed.sections,explanation:parsed.explanation||""});
}
return res.status(200).json({error:"No sections in response",raw:text.substring(0,200)});
}catch(e){
// Try to extract JSON from text
const m=text.match(/\{[\s\S]+\}/);
if(m)try{
const p=JSON.parse(m[0]);
if(p.sections)return res.status(200).json({sections:p.sections,explanation:p.explanation||""});
}catch(e2){}
return res.status(200).json({error:"Parse failed",raw:text.substring(0,300)});
}
}catch(e){
return res.status(500).json({error:e.message});
}
}
handler.config={maxDuration:60};
module.exports=handler;