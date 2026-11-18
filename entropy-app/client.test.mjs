import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), M=require('./model.js'), S=require('./scoring.js');
const seed=JSON.parse(readFileSync(new URL('./seed.json',import.meta.url),'utf8'));
let source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const tail=source.lastIndexOf('  render();\n  if (canDetectServer)');
assert.ok(tail>0);
source=source.slice(0,tail)+`  render = () => {};
  window.test = {applySnapshot,saveState,saveDecision,refreshBackend,importFile,exportCurrent,collectorAction,sourceStatus,
  authorPosts,openAuthor,closeAuthor,changeAuthorScope,moreAuthorPosts,getAuthor,renderBoard,filtered,engagementPercent,engagementLabel,scoreCell,
  renderReview,moderateRelevance,repairPost,postIdFromInput,hourlyProgress,relevanceSummary,
  review:value=>{reviewQuery=value.query??reviewQuery;reviewPage=value.page??reviewPage;},
  get:()=>({dataset,state,backend,serverState,busy,selected,authorPostScope,authorPostLimit}), ui:value=>{state.ui={...state.ui,...value};},
  context:value=>{modalContext=value;}};
})();`;
function harness(protocol='https:'){
 const storage=new Map(), elements=new Map(), blobs=[], queries=new Map(), listeners=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{id,hidden:id==='modal-root',value:'',innerHTML:'',textContent:'',isConnected:true,disabled:false,dataset:{},classList:{add(){},remove(){},toggle(){}},closest(){return null;},focus(){document.activeElement=this;},scrollIntoView(options){this.scrolled=options;},matches(){return false;},addEventListener(){},querySelectorAll(selector){return selector==='.post-card'?[...this.innerHTML.matchAll(/data-post-id="([^"]+)"/g)].map(match=>element('post-'+match[1])):[];}});return elements.get(id);};
 const document={getElementById:element,querySelectorAll:selector=>queries.get(selector)||[],querySelector:selector=>element(selector),addEventListener(type,fn){listeners.set(type,fn);},hidden:false,activeElement:{matches:()=>false},createElement:()=>({click(){}})};
 const Url=class extends URL{}; Url.createObjectURL=b=>{blobs.push(b);return 'blob:test';};Url.revokeObjectURL=()=>{};
 const context={window:{EntropyModel:M,EntropyScoring:S,EntropySeed:structuredClone(seed)},document,location:{protocol,search:''},
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},URL:Url,URLSearchParams,Intl,Date,AbortSignal,Blob,structuredClone,
 setTimeout:()=>1,clearTimeout(){},setInterval(){},fetch:async()=>{throw new Error('Unexpected fetch');}};
 vm.runInNewContext(source,context);return{t:context.window.test,context,storage,elements,element,blobs,queries,listeners};
}
const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(body)});
const snapshot=(revision,state=M.initialState())=>({dataset:structuredClone(seed),state:structuredClone(state),revision,sync:{enabled:false},connection:{configured:false,keySource:'none'},mode:'cloud'});
let checks=0;
{
 const h=harness();h.t.ui({search:'keep me',sort:'likes'});h.t.applySnapshot(snapshot(5));
 assert.equal(h.t.get().state.ui.search,'keep me');assert.equal(h.t.get().serverState.ui.search,'');
 assert.ok(!h.storage.has('entropy-workbench-v1'));assert.ok(h.storage.has('entropy-workbench-v1-ui'));
 let posted; const next=M.decision(h.t.get().state,{type:'ban',authorId:seed.authors[0].id,periodKey:'2026-11',reason:'Test visible reason'},'2026-11-17T12:00:00Z');
 h.context.fetch=async(path,options)=>{posted=JSON.parse(options.body);assert.equal(options.credentials,'same-origin');return response(200,snapshot(6,posted.state));};
 await h.t.saveState(next);assert.equal(posted.expectedRevision,5);assert.equal(posted.state.ui.search,'');assert.ok(h.t.get().state.bans[seed.authors[0].id]);assert.equal(h.t.get().state.ui.search,'keep me');checks++;
}
{
 const h=harness();h.t.applySnapshot(snapshot(5));const latest=M.decision(M.initialState(),{type:'ban',authorId:seed.authors[1].id,periodKey:'2026-11',reason:'Decision by another admin'},'2026-11-17T12:00:00Z');
 h.context.fetch=async(path,options)=>options.method==='POST'?response(409,{error:{code:'CONFLICT'}}):response(200,snapshot(7,latest));
 const next=M.decision(h.t.get().state,{type:'ban',authorId:seed.authors[0].id,periodKey:'2026-11',reason:'Pending client decision'},'2026-11-17T12:00:00Z');
 await assert.rejects(h.t.saveState(next),{code:'CONFLICT'});assert.equal(h.t.get().backend.revision,7);assert.ok(h.t.get().state.bans[seed.authors[1].id]);assert.ok(!h.t.get().state.bans[seed.authors[0].id]);checks++;
}
{
 const h=harness();h.t.applySnapshot(snapshot(5));let reject,calls=0;
 h.context.fetch=()=>{calls++;return new Promise((_,r)=>{reject=r;});};
 h.element('modal-root').hidden=false;h.element('public-reason').value='Detailed visible reason';h.element('internal-note').value='Private draft';
 h.t.context({type:'ban',authorId:seed.authors[0].id,periodKey:'2026-11'});
 const first=h.t.saveDecision(),second=h.t.saveDecision();await second;assert.equal(calls,1);assert.equal(h.t.get().busy,true);
 reject(new Error('offline'));await first;assert.equal(h.t.get().busy,false);assert.ok(!h.t.get().state.bans[seed.authors[0].id]);assert.equal(h.element('internal-note').value,'Private draft');assert.equal(h.element('modal-root').hidden,false);checks++;
}
{
 const h=harness();h.t.applySnapshot(snapshot(5));let resolve;
 h.context.fetch=()=>new Promise(r=>{resolve=r;});
 const read=h.t.refreshBackend();h.element('modal-root').hidden=false;resolve(response(200,snapshot(9)));await read;
 assert.equal(h.t.get().backend.revision,5);checks++;
}
{
 const h=harness();let calls=0;h.context.document.activeElement={matches:()=>true};h.context.fetch=async()=>{calls++;return response(200,snapshot(9));};
 await h.t.refreshBackend();assert.equal(calls,0);checks++;
}
{
 const h=harness('file:');let calls=0;h.context.fetch=()=>{calls++;throw new Error('No network allowed');};
 const next=M.decision(h.t.get().state,{type:'ban',authorId:seed.authors[0].id,periodKey:'2026-11',reason:'Offline local decision'},'2026-11-17T12:00:00Z');
 await h.t.saveState(next);assert.equal(calls,0);assert.ok(h.storage.has('entropy-workbench-v1'));checks++;
}
{
 const h=harness();h.t.applySnapshot(snapshot(5));let posted;
 h.context.fetch=async(path,options)=>{assert.equal(path,'/api/import');posted=JSON.parse(options.body);return response(200,snapshot(6));};
 await h.t.importFile({size:100,text:async()=>JSON.stringify(seed)});assert.equal(posted.expectedRevision,5);assert.equal(posted.isBackup,false);assert.equal(h.t.get().backend.revision,6);checks++;
}
{
 const h=harness();h.t.applySnapshot(snapshot(5));h.context.fetch=async()=>response(200,{...snapshot(9),connection:{configured:true,keySource:'environment',apiKey:'must-not-export'}});
 await h.t.exportCurrent(null);assert.equal(h.blobs.length,1);const body=JSON.parse(await h.blobs[0].text());assert.ok(!JSON.stringify(body).includes('must-not-export'));assert.ok(!('connection'in body));assert.equal(body.kind,'entropy-backup');checks++;
}
{
 const h=harness();h.context.fetch=async()=>response(404,{error:{code:'NOT_FOUND'}});await h.t.refreshBackend();assert.equal(h.t.get().backend.status,'local');
 const cloud=harness();cloud.context.fetch=async()=>response(401,{error:{code:'UNAUTHENTICATED'}});await cloud.t.refreshBackend();assert.equal(cloud.t.get().backend.status,'error');checks++;
}
{
 const h=harness(); h.t.applySnapshot(snapshot(9)); h.t.applySnapshot(snapshot(8)); assert.equal(h.t.get().backend.revision,9); checks++;
}
function postFixture(){
 const data=structuredClone(seed), authorId=data.authors[0].id, base=data.posts.find(post=>post.authorId===authorId);
 data.posts=data.posts.filter(post=>post.authorId!==authorId);
 for(let i=1;i<=25;i++)data.posts.push({...base,id:'fixture-'+i,url:'https://x.com/example/status/'+i,date:'2026-11-'+String(i).padStart(2,'0'),publishedAt:null,body:'Full saved Entropy post '+i,metrics:{...base.metrics,impressions:i*100}});
 data.posts.push({...base,id:'older-post',url:'https://x.com/example/status/100',date:'2026-10-31',publishedAt:null,body:'An older Entropy post'});
 return{data,authorId};
}
{
 const h=harness(), {data,authorId}=postFixture();
 let moderation=M.decision(M.initialState(),{type:'exclude-post',authorId,postId:'fixture-25',reason:'Visible post exclusion'},'2026-11-18T12:00:00Z');
 moderation=M.decision(moderation,{type:'exclude-period',authorId,periodKey:'2026-10',reason:'October author reason'},'2026-11-18T12:00:00Z');
 h.t.applySnapshot({...snapshot(5,moderation),dataset:data});h.t.openAuthor(authorId,h.element('trigger'));
 assert.equal(h.element('detail-panel').hidden,false);assert.equal(h.context.document.activeElement.id,'detail-title');assert.equal(h.element('detail-panel').scrolled.block,'start');
 assert.equal(h.t.authorPosts(authorId).length,25);assert.equal(h.t.authorPosts(authorId)[0].id,'fixture-25');
 let html=h.element('detail-panel').innerHTML;
 assert.equal((html.match(/data-post-id=/g)||[]).length,20);assert.ok(html.includes('Показано 20 із 25'));assert.ok(html.includes('Visible post exclusion'));assert.ok(html.includes('Full saved Entropy post 25'));assert.ok(!html.includes('data-post-id="older-post"'));
 const periodViews=h.t.getAuthor(authorId).metrics.impressions;
 h.t.moreAuthorPosts();assert.equal((h.element('detail-panel').innerHTML.match(/data-post-id=/g)||[]).length,25);assert.equal(h.context.document.activeElement.id,'post-fixture-5');
 h.t.changeAuthorScope('history');assert.equal(h.t.get().authorPostLimit,20);assert.equal(h.t.authorPosts(authorId).length,26);assert.equal(h.t.getAuthor(authorId).metrics.impressions,periodViews);
 h.t.moreAuthorPosts();html=h.element('detail-panel').innerHTML;
 assert.ok(html.includes('data-post-id="older-post"'));assert.ok(html.includes('Поза обраним періодом'));assert.ok(html.includes('October author reason'));assert.ok(html.includes('Показано 26 із 26'));assert.ok(!html.includes('data-action="author-post-more"'));checks++;
}
{
 const h=harness();h.t.applySnapshot(snapshot(5));const trigger=h.element('trigger');trigger.dataset.author=seed.authors[0].id;
 h.t.openAuthor(seed.authors[0].id,trigger);let calls=0;h.context.fetch=async()=>{calls++;return response(200,snapshot(6));};
 await h.t.refreshBackend();assert.equal(calls,0);
 trigger.isConnected=false;const replacement=h.element('replacement');replacement.dataset.author=trigger.dataset.author;h.queries.set('[data-action="open-author"]',[replacement]);
 let prevented=false;h.listeners.get('keydown')({key:'Escape',preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(h.t.get().selected,null);assert.equal(h.element('detail-panel').hidden,true);assert.equal(h.context.document.activeElement,replacement);assert.equal(replacement.scrolled.block,'center');
 await h.t.refreshBackend();assert.equal(calls,1);assert.equal(h.t.get().backend.revision,6);checks++;
}
{
 const h=harness(), {data,authorId}=postFixture(), base=data.posts.find(post=>post.id==='fixture-1');
 const make=(id,facts={})=>({...base,id,workId:id,date:'2026-11-10',url:'https://x.com/example/status/'+id,body:id+' Entropy body',metrics:{...base.metrics,impressions:1000,likes:10,reposts:2,quotes:1,replies:5},...facts});
 data.posts=[make('policy-root'),make('policy-quote',{isQuote:true}),make('policy-reply',{isReply:true}),make('policy-self-reply',{isReply:false,inReplyToId:'policy-root'}),make('policy-repost',{isRetweet:true})];
 const state=M.decision(M.initialState(),{type:'exclude-post',authorId,postId:'policy-reply',reason:'Earlier manual reply reason'},'2026-11-18T12:00:00Z');
 h.t.applySnapshot({...snapshot(5,state),dataset:data});h.t.openAuthor(authorId,h.element('trigger'));
 const a=h.t.getAuthor(authorId), html=h.element('detail-panel').innerHTML;
 assert.equal(a.posts.length,2);assert.equal(a.metrics.impressions,2000);assert.equal(h.t.engagementPercent(a),1.3);
 assert.ok(html.includes('реплаї')||html.includes('Реплаї'));assert.ok(html.includes('Показано 5 із 5'));
 for(const id of ['policy-reply','policy-self-reply','policy-repost']){
  const card=html.split('data-post-id="'+id+'"')[1].split('</article>')[0];
  assert.ok(card.includes(id+' Entropy body'));assert.ok(card.includes('не враховується'));
  assert.ok(!card.includes('data-action="restore-post"'));assert.ok(!card.includes('data-action="moderate-post"'));
 }
 assert.ok(html.includes('Earlier manual reply reason'));
 const original=html.split('data-post-id="policy-root"')[1].split('</article>')[0];
 assert.ok(original.includes('Враховано в метриках'));assert.ok(original.includes('data-action="moderate-post"'));
 assert.equal(h.t.get().state.audit.length,1);checks++;
}
{
 const h=harness();h.t.openAuthor(seed.authors[0].id,h.element('trigger'));let calls=0;
 h.context.fetch=async()=>{calls++;return response(200,snapshot(6));};await h.t.refreshBackend();
 assert.equal(calls,1);assert.equal(h.t.get().backend.status,'connected');checks++;
}
{
 const h=harness(), timeouts=[];h.t.applySnapshot(snapshot(5));
 h.context.AbortSignal={timeout:milliseconds=>{timeouts.push(milliseconds);return undefined;}};
 h.context.fetch=async()=>response(200,snapshot(6));
 await h.t.collectorAction(true,true);assert.equal(timeouts.pop(),90000);
 await h.t.collectorAction(false,false);assert.equal(timeouts.pop(),45000);
 await h.t.refreshBackend(true);assert.equal(timeouts.pop(),45000);checks++;
}

{
 const h=harness();h.t.applySnapshot(snapshot(5));h.t.renderBoard();
 const expected=h.t.filtered().filter(author=>author.participates&&author.metrics.impressions!==null).slice(0,3);
 const cards=h.element('top-creators').innerHTML;
 assert.equal((cards.match(/<article class="leader-card /g)||[]).length,3);
 let previous=-1;for(const author of expected){const at=cards.indexOf('data-author="'+author.author.id+'"');assert.ok(at>previous);previous=at;}
 assert.ok(!cards.includes('<svg'));assert.ok(cards.includes('Від показника лідера'));
 const banned=M.decision(M.initialState(),{type:'ban',authorId:expected[0].author.id,periodKey:'2026-11',reason:'Excluded creator'},'2026-11-18T12:00:00Z');
 h.t.applySnapshot(snapshot(6,banned));h.t.renderBoard();assert.ok(!h.element('top-creators').innerHTML.includes('data-author="'+expected[0].author.id+'"'));
 h.t.ui({status:'banned'});h.t.renderBoard();assert.equal(h.element('top-creators').hidden,true);
 h.t.ui({status:'active',sort:'likes'});h.t.renderBoard();assert.ok(h.element('top-creators').innerHTML.includes('Лайків за обраний період'));checks++;
}
{
 const h=harness();const latest='2026-11-18T12:00:00Z',other='2026-11-18T19:00:00Z';
 h.t.applySnapshot({...snapshot(5),connection:{configured:true},sync:{enabled:true,paused:false,lastSuccessAt:other,
  hourly:{lastSuccessAt:latest,nextRunAt:'2026-11-18T13:00:00Z',pendingWindows:[]},collectionHealth:{freshness:'current'},
  backfill:{status:'complete-with-gaps',addedPosts:0},metricsRefresh:{lastError:{message:'internal details must not render'}}}});
 h.t.renderBoard();const format=value=>new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
 assert.ok(h.t.sourceStatus().includes(format(latest)));assert.ok(!h.t.sourceStatus().includes(format(other)));
 assert.ok(!h.t.sourceStatus().includes('додано постів 0'));assert.ok(h.element('freshness-note').innerHTML.includes('Метрики частини постів очікують оновлення'));
 assert.ok(!h.element('freshness-note').innerHTML.includes('internal details'));
 h.t.applySnapshot({...snapshot(6),connection:{configured:true},sync:{enabled:false,paused:false,hourly:{lastSuccessAt:latest}}});
 assert.ok(h.t.sourceStatus().includes('Збір призупинено'));checks++;
}

{
 const h=harness(), data=structuredClone(seed), authorId=data.authors[0].id, base=data.posts.find(post=>post.authorId===authorId);
 data.posts=[
  {...base,id:'er-1',date:'2026-11-01',metrics:{...base.metrics,impressions:1000,likes:10,reposts:2,quotes:3,replies:999}},
  {...base,id:'er-2',date:'2026-11-02',metrics:{...base.metrics,impressions:500,likes:4,reposts:1,quotes:0,replies:888}},
 ];
 h.t.applySnapshot({...snapshot(5),dataset:data});
 const aggregate=h.t.getAuthor(authorId);
 assert.equal(h.t.engagementPercent(aggregate),20/1500*100);
 h.t.renderBoard();
 const table=h.element('leaderboard-body').innerHTML;
 assert.ok(table.includes('engagement-cell'));
 assert.ok(table.includes('1,33%'));
 assert.ok(table.includes('Недостатньо даних'));
 assert.ok(table.includes('Бракує:'));
 h.t.openAuthor(authorId,h.element('trigger'));
 assert.ok(h.element('detail-panel').innerHTML.includes('Engagement<strong>1,33%</strong>'));
 assert.ok(h.element('detail-panel').innerHTML.includes('Score<strong>'));
 const moderation=M.decision(M.initialState(),{type:'exclude-post',authorId,postId:'er-1',reason:'Exclude this post'},'2026-11-18T12:00:00Z');
 h.t.applySnapshot({...snapshot(6,moderation),dataset:data});
 assert.equal(h.t.engagementPercent(h.t.getAuthor(authorId)),1);
 assert.ok(h.t.scoreCell(h.t.getAuthor(authorId)).includes('Не допущено'));checks++;
}
{
 const h=harness();
 const aggregate={participates:true,score:{score:null,status:'incomplete',missing:['smartFollowers'],components:{ERpercent:null}}};
 assert.equal(h.t.engagementLabel(aggregate),'—');
 aggregate.score.components.ERpercent=0;
 assert.equal(h.t.engagementLabel(aggregate),'0%');
 aggregate.participates=false;
 assert.ok(h.t.scoreCell(aggregate).includes('Не враховано'));
 aggregate.participates=true;aggregate.score.score=123.4;aggregate.score.status='eligible';
 assert.equal(h.t.scoreCell(aggregate),'123,4');
 aggregate.score.status='review';
 assert.ok(h.t.scoreCell(aggregate).includes('Попередній · на перевірці'));checks++;
}

{
 const h=harness(),{data,authorId}=postFixture(),base=data.posts[0];
 const review={version:'entropy-context-v1',status:'review',reasonCodes:['AMBIGUOUS_ENTROPY'],signals:['brand_name']};
 data.posts=Array.from({length:25},(_,n)=>({...base,id:'review-'+n,authorId,date:'2026-11-'+String(n+1).padStart(2,'0'),body:'Entropy <script>alert(1)</script> '+n,relevance:structuredClone(review)}));
 h.t.applySnapshot({...snapshot(5),dataset:data}); h.t.renderReview();
 let html=h.element('review-content').innerHTML;
 assert.equal((html.match(/data-review-post-id=/g)||[]).length,20);assert.ok(html.includes('Очікують перевірки: 25'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
 assert.ok(html.includes('data-action="approve-relevance"'));assert.ok(html.includes('data-action="reject-relevance"'));assert.equal(h.t.getAuthor(authorId).posts.length,0);
 const firstIds=[...html.matchAll(/data-review-post-id="([^"]+)"/g)].map(match=>match[1]);
 h.t.review({page:1});h.t.renderReview();html=h.element('review-content').innerHTML;
 const lastIds=[...html.matchAll(/data-review-post-id="([^"]+)"/g)].map(match=>match[1]);
 assert.equal(lastIds.length,5);assert.equal(new Set([...firstIds,...lastIds]).size,25);
 h.t.review({query:'Entropy <script>alert(1)</script> 24',page:0});h.t.renderReview();assert.equal((h.element('review-content').innerHTML.match(/data-review-post-id=/g)||[]).length,1);checks++;
}
{
 const h=harness();h.t.applySnapshot(snapshot(5));const post=seed.posts[0];
 const next=M.decision(h.t.get().state,{type:'reject-relevance',authorId:post.authorId,postId:post.id,reason:'Different Entropy context',internalNote:'PRIVATE_CONTEXT_DRAFT'},'2026-11-18T12:00:00Z');
 let posted;h.context.fetch=async(path,options)=>{posted=JSON.parse(options.body);assert.equal(path,'/api/state');return response(200,snapshot(6,posted.state));};
 await h.t.saveState(next);assert.equal(posted.state.postRelevance[post.id].action,'reject');assert.equal(h.t.get().state.postRelevance[post.id].internalNote,'PRIVATE_CONTEXT_DRAFT');checks++;
}
{
 const h=harness();
 for(const input of ['https://x.com/author/status/2122895908258054477?s=20','https://twitter.com/i/web/status/2122895908258054477','2122895908258054477'])assert.equal(h.t.postIdFromInput(input),'2122895908258054477');
 for(const input of ['https://x.com.evil.test/author/status/12','http://x.com/author/status/12','https://user:pass@x.com/author/status/12','https://x.com:4433/author/status/12','https://x.com/author','javascript:alert(1)','-1','0'])assert.equal(h.t.postIdFromInput(input),null);
 h.t.applySnapshot(snapshot(5));h.element('repair-post-input').value='https://example.com/not-a-post';let calls=0;
 h.context.fetch=async()=>{calls++;throw new Error('Must not call provider for invalid input');};await h.t.repairPost();assert.equal(calls,0);assert.ok(h.element('repair-post-result').textContent.includes('коректне'));checks++;
}
{
 const h=harness(),timeouts=[];h.t.applySnapshot(snapshot(5));h.element('repair-post-input').value='https://x.com/quang250802/status/2122895908258054477';
 h.context.AbortSignal={timeout:value=>{timeouts.push(value);return undefined;}};
 let posted;h.context.fetch=async(path,options)=>{assert.equal(path,'/api/repair');posted=JSON.parse(options.body);return response(200,{...snapshot(6),sync:{enabled:true,postRepair:{status:'complete',queuedForReview:1,accepted:0}}});};
 await h.t.repairPost();assert.equal(posted.expectedRevision,5);assert.deepEqual(posted.ids,['2122895908258054477']);assert.equal(timeouts.at(-1),90000);assert.ok(h.element('repair-post-result').textContent.includes('черги перевірки'));assert.equal(h.t.get().backend.revision,6);checks++;
}
{
 const h=harness();h.t.applySnapshot(snapshot(5));h.element('repair-post-input').value='2122712010097844473';let calls=0,release;
 h.context.fetch=async()=>{calls++;return new Promise(resolve=>{release=()=>resolve(response(200,{...snapshot(6),sync:{postRepair:{status:'complete',accepted:1}}}));});};
 const first=h.t.repairPost(),second=h.t.repairPost();await second;assert.equal(calls,1);assert.equal(h.t.get().busy,true);release();await first;assert.equal(h.t.get().busy,false);assert.ok(h.element('repair-post-result').textContent.includes('Пост перевірено'));checks++;
}
{
 const h=harness();const html=h.t.hourlyProgress({hourly:{lastSuccessAt:'2026-11-18T12:00:00Z',pendingWindows:[{discoveryLane:'context'},{discoveryLane:'context'},{discoveryLane:'evidence'}],lanes:{direct:{lastSuccessAt:'2026-11-18T12:00:00Z'},evidence:{lastSuccessAt:null},context:{lastSuccessAt:null,lastError:{code:'TIMEOUT'}}}}});
 assert.ok(html.includes('Відмітки @entropyIO'));assert.ok(html.includes('Офіційні посилання й цитування'));assert.ok(html.includes('Entropy без відмітки'));assert.ok(html.includes('Вікон у черзі: 2'));assert.ok(html.includes('Успішна сторінка не підтверджує повноту'));assert.ok(html.includes('очікує повторної спроби'));checks++;
}

{
 const h=harness();
 const base={id:'untrusted-context',relevance:{version:'entropy-context-v1',status:'review',reasonCodes:['AMBIGUOUS_ENTROPY'],signals:['fake_official_domain']}};
 assert.ok(!h.t.relevanceSummary(base).includes('Посилання на офіційний ресурс'));
 const conflict={...base,relevance:{...base.relevance,reasonCodes:['CONFLICTING_CONTEXT'],signals:['product_context','other_project_context']}};
 assert.ok(h.t.relevanceSummary(conflict).includes('іншого проєкту'));assert.ok(h.t.relevanceSummary(conflict).includes('ручна перевірка'));checks++;
}

{
 const h=harness();let resolve,calls=0;
 h.context.document.hidden=true;
 h.context.fetch=()=>{calls++;return new Promise(done=>{resolve=done;});};
 const initialRead=h.t.refreshBackend(true);
 assert.equal(calls,1,'bootstrap reads even while the tab is hidden');
 h.t.ui({search:'typed before the first response'});
 h.context.document.activeElement={matches:()=>true};
 const latest=snapshot(15);latest.dataset.posts.push({...latest.dataset.posts[0],id:'first-server-only-post',url:'https://x.com/example/status/9898989898989898989'});
 resolve(response(200,latest));await initialRead;
 assert.equal(h.t.get().backend.status,'connected');assert.equal(h.t.get().backend.revision,15);
 assert.equal(h.t.get().dataset.posts.length,seed.posts.length+1);
 assert.equal(h.t.get().state.ui.search,'typed before the first response');
 assert.equal(h.t.get().serverState.ui.search,'');
 await h.t.refreshBackend();assert.equal(calls,1,'later reads continue to respect the focused input');
 assert.ok(readFileSync(new URL('./app.js',import.meta.url),'utf8').includes('void refreshBackend(true).catch(() => {});'));checks++;
}

console.log(checks+' focused client integration checks passed (mocked network, no browser).');
