const D = window.BENCH_DATA
const state = { page: 'compare', run: 'native', family: 'agent-task', model: '', loss: false, metric: 'input', task: 0, pair: 0, variant: 'new', tab: 'trace' }
const labels = { 'real-file-path': '交付文件定位', 'real-game-steering': '途中纠正游戏线索', 'real-workbook-summary': '工作簿分类汇总', 'real-intrachapter-duplication': '章节内重复检测', 'closure-real-io-complete': '完整回答后的收尾判断', 'closure-real-io-truncated': '遗漏问题的收尾判断' }
const pages = { runs: '实验记录', compare: '版本对照', tasks: '任务与标准', reviews: '评审工作台' }
const dims = { accuracy: '准确性', coverage: '完整性', verification: '验证证据', boundary: '边界遵守', delivery: '交付质量' }
const criterionNames = { 'research-facts':'研究事实', 'source-synthesis':'来源综合', 'deliverable-coverage':'交付覆盖', 'reproduction-scope':'复现范围', 'execution-evidence':'执行证据', 'final-audit':'最终审核', 'honest-boundary':'如实说明边界', 'authorized-actions':'操作授权', 'article-usability':'文章可用性', 'visual-quality':'配图质量' }
const checks = { 'legacy-pass':'历史任务验收', artifacts:'产物检查', 'task-pass': '任务机械验收', finished: '执行完成', answer: '提供最终答复', facts: '事实匹配', authorized: '操作授权', requiredEffects: '必要产物与结果', requiredTools: '必要工具', noSecretLeak: '敏感信息检查', noPolling: '无重复轮询' }
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
const num = v => v == null ? '未知' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 })
const model = v => v.replace('chatgpt/', '').replace('gpt-6-astra', 'GPT 6 Astra').replace('gpt-5.6-sol', 'GPT 5.6 Sol').replace('gpt-5.5', 'GPT 5.5')
const run = () => D.runs.find(r => r.id === state.run)
const value = (r, m) => m === 'duration' ? r.durationMs / 1000 : m === 'tools' ? r.measurements.execution.toolCalls : r.measurements.execution.usage[m]
const sum = (rows, f) => rows.length && rows.every(r => f(r) != null) ? rows.reduce((s,r) => s + f(r), 0) : null
function pairs() {
 const groups = new Map()
 for (const r of run().rows) {
  if (r.case.family !== state.family || state.model && r.target !== state.model) continue
  const key = [r.case.id,r.target,r.environment.fingerprint,r.comparisonKey,r.block,r.rep].join('|')
  if (!groups.has(key)) groups.set(key, {})
  groups.get(key)[r.variant.id.includes('before') ? 'old' : 'new'] = r
 }
 return [...groups.values()].map(p => {
  const known = p.old && p.new && [p.old,p.new].every(r => r.status === 'ok' && ['passed','failed'].includes(r.evaluation.verdict))
  return { ...p, result: !known ? '未知' : p.old.evaluation.verdict === p.new.evaluation.verdict ? '持平' : p.new.evaluation.verdict === 'passed' ? '改善' : '退步' }
 })
}
const heading = (title, desc, tag='') => `<div class="heading"><div><div class="eyebrow">Evaluation workspace</div><h1>${title}</h1><p class="sub">${desc}</p></div>${tag ? `<span class="tag cyan">${tag}</span>` : ''}</div>`
const verdict = r => r ? ({passed:'通过',failed:'未通过',needs_review:'待评审'}[r.evaluation.verdict] || '未知') : '缺失'
function compare() {
 const all = pairs(), shown = all.filter(p => !state.loss || p.result === '退步')
 const rows = shown.flatMap(p => [p.old,p.new].filter(Boolean))
 const models = [...new Set(run().rows.map(r => r.target))].sort()
 const metricNames = { input:'未缓存输入 token',output:'输出 token',tools:'工具调用次数',duration:'耗时 / 秒' }
 const bars = models.filter(m => (!state.model || m === state.model) && shown.some(p => (p.old || p.new).target === m)).map(m => {
  const subset = shown.filter(p => (p.old || p.new).target === m)
  return { name:model(m), old:sum(subset.map(p => p.old).filter(Boolean),r => value(r,state.metric)), new:sum(subset.map(p => p.new).filter(Boolean),r => value(r,state.metric)) }
 })
 const max = Math.max(1,...bars.flatMap(b => [b.old || 0,b.new || 0]))
 return heading('提示词变更，带来了什么？','同一批次、任务、模型与环境内配对；质量结论来自当前机械验收。','真实模型 · 模拟工具') + `
 <div class="filters"><label>实验<select id="run">${D.runs.map(r => `<option value="${r.id}" ${r.id===state.run?'selected':''}>${r.title}</option>`).join('')}</select></label><label>范围<select id="family"><option value="agent-task" ${state.family==='agent-task'?'selected':''}>主任务</option><option value="closure-classification" ${state.family==='closure-classification'?'selected':''}>收尾判断</option></select></label><label>模型<select id="model"><option value="">全部模型</option>${models.map(m => `<option ${state.model===m?'selected':''} value="${m}">${model(m)}</option>`).join('')}</select></label><label class="check-label"><input id="loss" type="checkbox" ${state.loss?'checked':''}>只看退步</label></div>
 <div class="version-line"><strong>基线</strong><code>real-before-20260906</code><span class="to">→</span><strong>候选</strong><code>real-after-20260906</code><span class="scope">当前筛选 ${shown.length} 对 · ${rows.length} 次执行 · 每组合 1 次</span></div>
 <div class="stats">${['改善','退步','持平','未知'].map(t => `<div class="stat"><div class="number ${t==='退步'?'bad':''}">${shown.filter(p => p.result===t).length}</div><div class="label">${t==='未知'?'不可比 / 待评审':t} · 配对任务</div></div>`).join('')}</div>
 <div class="note ${shown.some(p=>p.result==='退步')?'warn':''}">${shown.some(p=>p.result==='退步')?'候选版本有任务退步。先检查交付证据，再解释用量变化。':'当前仅一次重复；“持平”表示机械验收结果一致，不能据此认定语义质量相同或提示词更好。'}</div>
 ${shown.length ? `<div class="work-grid"><section><div class="panel-head"><h2>执行消耗 · 按模型汇总</h2><select id="metric" aria-label="消耗指标">${Object.entries(metricNames).map(([k,v])=>`<option value="${k}" ${state.metric===k?'selected':''}>${v}</option>`).join('')}</select></div><div class="legend"><span><i></i>基线</span><span><i class="new"></i>候选</span></div>${bars.map(b=>`<div class="bar-row"><span class="bar-label">${b.name}</span><div class="bars">${['old','new'].map(k=>`<div class="bar-track"><div class="bar ${k}" style="width:${Math.max(0,(b[k]||0)/max*75)}%"></div><span class="bar-value">${num(b[k])}</span></div>`).join('')}</div></div>`).join('')}<p class="sub">两版本均按当前筛选汇总，不包含评审消耗。更短、更省不自动代表更好。</p></section><section class="ledger"><h2>计量完整性</h2>${[
 ['执行模型调用',num(sum(rows,r=>r.measurements.execution.modelCalls))+' 次'],['执行工具调用',num(sum(rows,r=>r.measurements.execution.toolCalls))+' 次'],['评审模型调用',num(sum(rows,r=>r.measurements.evaluation.modelCalls))],['缓存写入 token',num(sum(rows,r=>r.measurements.execution.usage.cacheWrite))],['模型费用','未知 · 缺少计费信息']].map(([k,v])=>`<div class="ledger-row"><span>${k}</span><strong>${v}</strong></div>`).join('')}<p class="sub">未知值不按 0 累加。工具免费记录与模型费用分开；推理 token 属于输出的子集。</p></section></div>
 <section class="table-section"><div class="panel-head"><h2>逐任务对照 <span class="rule-count">${shown.length} 对</span></h2><span class="sub">基线 → 候选</span></div><div class="table-wrap"><table><thead><tr><th>任务</th><th>模型</th><th>机械验收</th><th>输入 token</th><th>工具</th><th>耗时 / 秒</th><th></th></tr></thead><tbody>${shown.map(p=>`<tr><td>${esc(labels[(p.old||p.new).case.id] || (p.old||p.new).case.id)}</td><td>${model((p.old||p.new).target)}</td><td class="${p.result==='退步'?'bad':''}"><span class="result-label">${verdict(p.old)} → ${verdict(p.new)}</span></td>${['input','tools','duration'].map(m=>`<td class="numeric"><span class="old">${p.old?num(value(p.old,m)):'缺失'}</span><span class="arrow">→</span>${p.new?num(value(p.new,m)):'缺失'}</td>`).join('')}<td><button class="row-link" data-detail="${all.indexOf(p)}">查看证据 ↗</button></td></tr>`).join('')}</tbody></table></div></section>` : `<div class="empty"><h2>当前筛选没有退步记录</h2><p>没有观察到退步，不表示提示词已改善。</p><button id="reset-loss">显示全部配对</button></div>`}`
}
function runsPage() { return heading('实验记录','每批实验独立保存。历史导入和原生执行保留各自的证据完整性。') + `<div class="table-wrap"><table><thead><tr><th>实验</th><th>来源</th><th>执行数</th><th>模型数</th><th>机械验收通过</th><th>独立评审</th><th></th></tr></thead><tbody>${D.runs.map(r=>`<tr><td>${r.title}<p class="sub">2026.09.06 · 模拟工具</p></td><td><span class="tag">${r.id==='native'?'原生执行':'历史导入'}</span></td><td>${r.rows.length}</td><td>${new Set(r.rows.map(t=>t.target)).size}</td><td>${r.rows.filter(t=>t.evaluation.verdict==='passed').length} / ${r.rows.length}</td><td class="warn">未开始</td><td><button class="row-link" data-run="${r.id}">版本对照 →</button></td></tr>`).join('')}</tbody></table></div><div class="note">这是已保存结果的只读快照。运行中状态、启动实验与自动刷新将在执行状态接口接入后提供。</div>` }
function tasksPage() {
 const task=D.rubric.tasks[state.task]
 return heading('任务与标准','先明确“交付得怎样才算通过”，再评价具体运行。','标准待校准')+`<div class="note warn">14 个任务、75 条标准是独立的标准库，尚未自动用于上述运行评分；不要将机械通过率换算成这里的质量分。</div><div class="standards"><div class="task-list" aria-label="任务标准">${D.rubric.tasks.map((t,i)=>`<button data-task="${i}" class="${state.task===i?'active':''}">${esc(t.title)}</button>`).join('')}</div><section><h2>${esc(task.title)}</h2><p class="sub">${task.criteria.length} 条标准 · 权重合计 ${task.criteria.reduce((s,c)=>s+c.weight,0)} · 关键项失败需单独处理</p>${task.criteria.map(c=>`<article class="criterion"><header><h3>${esc(dims[c.id]||criterionNames[c.id]||c.id)} <span class="rule-count">权重 ${c.weight}</span></h3><span class="${c.critical?'warn':'muted'}">${c.critical?'关键项':'一般项'}</span></header><p>${esc(c.full)}</p><details><summary>查看部分通过、失败与证据要求</summary><p>部分通过：${esc(c.partial)}</p><p>失败：${esc(c.zero)}</p><p>需要证据：${esc(c.evidence)}</p>${c.partialBlocksDelivery?'<p class="warn">部分通过仍阻止交付验收。</p>':''}</details></article>`).join('')}</section></div>`
}
function reviewsPage() { return heading('评审工作台','把机械检查、独立判断和最终验收分开记录。')+`<div class="empty"><div class="eyebrow">Review workflow</div><h2>独立评审尚未接入</h2><p>当前两批记录仅有机械验收结果，没有独立盲评结论。</p><button disabled title="设计阶段，评审服务尚未接入">开始盲评</button></div><div class="queue"><div><h2>01 · 准备证据包</h2><p>原始任务、冻结标准、执行过程和最终产物完整关联；证据缺失明确标记。</p></div><span class="tag">待实现</span></div><div class="queue"><div><h2>02 · 隐去模型与版本，逐项评审</h2><p>每条标准选择通过、部分通过、失败或无法判断，并绑定依据。评审费用单独记录。</p></div><span class="tag">待实现</span></div><div class="queue"><div><h2>03 · 处理分歧，再发布结论</h2><p>保留评审版本与人工复核历史；未完成的评分不展示总分。质量结论和成本变化分别呈现。</p></div><span class="tag">待实现</span></div>` }
function render() {
 document.querySelector('#crumb').textContent=pages[state.page]
 document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===state.page))
 document.querySelector('#content').innerHTML=({compare,runs:runsPage,tasks:tasksPage,reviews:reviewsPage})[state.page]()
 for (const id of ['run','family','model','metric','loss']) document.getElementById(id)?.addEventListener('change',e=>{state[id]=id==='loss'?e.target.checked:e.target.value; render()})
 document.querySelector('#reset-loss')?.addEventListener('click',()=>{state.loss=false;render()})
 document.querySelectorAll('[data-run]').forEach(b=>b.onclick=()=>{state.run=b.dataset.run;state.page='compare';state.loss=false;render()})
 document.querySelectorAll('[data-task]').forEach(b=>b.onclick=()=>{state.task=Number(b.dataset.task);render()})
 document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>{state.pair=Number(b.dataset.detail);state.variant='new';state.tab='trace';detail();document.querySelector('#detail').showModal()})
}
function detail() {
 const p=pairs()[state.pair], r=p[state.variant]
 if (!r) return
 document.querySelector('#detail-content').innerHTML=`<div class="dialog-top"><div><div class="eyebrow">Trial evidence</div><h2 id="detail-title">${esc(labels[r.case.id]||r.case.id)}</h2><p>${model(r.target)} · 重复 ${r.rep}</p></div><button id="close-detail" aria-label="关闭详情">✕</button></div><div class="pair-summary"><div><p>机械验收</p><strong class="${verdict(r)==='未通过'?'bad':''}">${verdict(r)}</strong></div><div><p>执行耗时</p><strong>${num(r.durationMs/1000)} <small>秒</small></strong></div></div><div class="button-group">${['old','new'].map(v=>`<button data-variant="${v}" class="pill-button ${state.variant===v?'active':''}">${v==='old'?'基线':'候选'}</button>`).join('')}</div><div class="tabs">${[['trace','调用过程'],['checks','验收证据']].map(([k,v])=>`<button data-tab="${k}" class="${state.tab===k?'active':''}">${v}</button>`).join('')}</div>${state.tab==='trace' ? r.operations.length ? r.operations.map((o,i)=>`<div class="timeline-item ${o.kind}"><h3><span>${i+1}. ${o.kind==='model'?'模型':'工具'} · ${esc(o.name)}</span><span class="muted">${num(o.durationMs)} ms</span></h3><p>${o.status==='ok'?'调用成功':'调用失败'}${o.usage?` · 输入 ${num(o.usage.input)} / 输出 ${num(o.usage.output)} token`:''}</p><details><summary>查看指纹</summary><p>输入 ${esc(o.inputHash)}<br>输出 ${esc(o.outputHash)}</p></details></div>`).join('') : `<div class="note warn">历史导入未提供逐步事件。下方是已记录的汇总，不表示调用次数为 0。</div>${Object.entries(r.measurements.execution.tools).map(([k,v])=>`<div class="ledger-row"><span>${esc(k)}</span><strong>${num(v.calls)} 次 · ${num(v.errors)} 错误</strong></div>`).join('')||'<p>该任务未记录工具调用。</p>'}` : `<div class="note">这些是已运行的机械检查，不等同于独立质量评审。证据正文未加载到此原型。</div>${r.evaluation.checks.map(c=>`<div class="check-row"><span>${esc(checks[c.id]||c.id)}</span><span class="${c.passed===false?'bad':c.passed===null?'warn':''}">${c.passed===null?'未知':c.passed?'通过':'未通过'}</span></div>`).join('')}<div class="space"></div><h3>证据索引 · ${r.evidence.length} 项</h3>${r.evidence.map(e=>`<p class="sub">${esc(e.id)} · ${esc(e.kind)}<br><code>${esc(e.sha256.slice(0,24))}…</code></p>`).join('')}`}<div class="note">当前环境：模拟工具。工具参数与结果指纹用于追溯差异，不能单独证明最终产物正确。</div>`
 document.querySelector('#close-detail').onclick=()=>document.querySelector('#detail').close()
 document.querySelectorAll('[data-variant]').forEach(b=>b.onclick=()=>{state.variant=b.dataset.variant;detail()})
 document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;detail()})
}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{state.page=b.dataset.page;render()})
render()
