// High-confidence signals in untrusted discussion text. The event Worker independently
// has no tools. Never use this content filter to authorize execution of a comment.
const dangerousCommands = [
  /\brm\s+(?:--(?:recursive|force)\b|-[a-z]*[rf][a-z]*\b)/iu,
  /\brm\s+(?:--\s+)?(?:\/(?:etc|home|usr|var|root)\/|[~$][^;\n]{0,20}\/\.ssh\/|\.(?:env|git)(?:\s|\/|$))/iu,
  /\b(?:mkfs(?:\.\w+)?\s+\/dev\/|dd\s+[^;|\n]{0,160}\bof=\/dev\/|chmod\s+(?:-r\s+)?0?777\b)/iu,
  /\bgit\s+(?:push\b[^;|\n]{0,120}(?:--force\b|-f\b)|reset\s+--hard\b|clean\s+-[a-z]*f)/iu,
  /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\s+["'\w]/iu,
  /\b(?:kubectl\s+delete\s+(?:namespace|ns|secrets?)\b|gh\s+repo\s+delete\b|gh\s+pr\s+merge\b[^;\n]{0,100}--admin\b)/iu,
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|;]{1,512}\|\s*(?:sudo\s+)?(?:\/usr\/bin\/env\s+)?(?:(?:\/usr)?\/bin\/)?(?:(?:ba|z|k)?sh|python[23]?|node|ruby|perl|pwsh|iex|invoke-expression)\b/iu,
  /\b(?:ba|z|k)?sh\s+<\(\s*(?:curl|wget)\b/iu,
  /\b(?:iex|invoke-expression)\s*\(\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b/iu,
  /\b(?:curl|wget)\b[^\n;|&]{1,512}(?:&&|;)\s*(?:sudo\s+)?(?:\/usr\/bin\/env\s+)?(?:(?:\/usr)?\/bin\/)?(?:bash|sh|zsh)\s/iu,
  /\b(?:curl|wget)\b[^|;\n]{0,500}(?:@[^\s;|]*(?:\.env\b|id_(?:rsa|ed25519)\b)|\$\{?[a-z_]*(?:token|secret|password|api_key)\b)/iu,
  /\b(?:cat|printenv|echo)\s+[^;|\n]{0,60}(?:\.env\b|id_(?:rsa|ed25519)\b|[a-z_]*(?:token|secret|password|api_key)\b)/iu,
]

const credential =
  /(?:\b(?:[a-z0-9]+_)*(?:token|password|secret|api[_ -]?key|private[_ -]?key|credentials?|id_(?:rsa|ed25519))s?\b|\.env\b|密码|密[钥鑰]|秘[钥鑰]|凭据|令牌|私钥)/iu
const disclosure =
  /\b(?:send|share|post|upload|publish|paste|disclose|reveal|leak|export|print|dump|give me|show me)\b|发送|转发|发给|发到|发我|发一下|贴出|贴到|贴在|粘贴|上传|导出|输出|打印|泄[露漏]|公布|提供|交出/giu
const clauseBreak = /[。！？；;!?\n]|\.(?=\s|$)/u
const negated =
  /(?:\b(?:never|avoid|no longer|don't|do not|must not|should not)|(?:不应(?:该)?|请勿|不要|禁止|不能|切勿|避免|不可|不允许))\s*$/iu

const privilegedRequests = [
  /\b(?:ignore|bypass|override|forget|disregard)\s+(?:(?:all|any|the|your|our|previous|prior|system|developer|safety|security|earlier|above)\s+)+(?:instructions?|prompts?|rules?|checks?|guardrails?|approvals?)\b/giu,
  /(?:忽略|无视|绕过|覆盖|跳过)(?:(?:之前|先前|此前|以上|上面|前面|原有|所有|全部|已有|当前|系统|开发者|安全|权限)(?:的)?){1,6}(?:指令|规则|提示词|约束|限制|检查|审批|审核|验证|校验)/gu,
  /\b(?:disable|bypass|turn off)\s+(?:(?:all|the|mandatory|required)\s+)*(?:branch protection|security checks?|permission checks?|authentication|2fa|mfa|code review)\b/giu,
  /\b(?:bypass|skip)\s+(?:(?:the|required|mandatory|code)\s+)*(?:review|approval)s?\b|\bmerge\b[^.;!?\n]{0,65}?\b(?:without|skip(?:ping)?|bypass(?:ing)?|no)\s+(?:(?:any|the|required|code)\s+)*(?:review|approval)s?\b/giu,
  /(?:绕过|跳过|不经|不需要|不用|无需|免于)(?:任何|代码|人工|PR\s*)?(?:审查|审核|审批|评审|批准)[^。；;!?\n]{0,28}合并|合并[^。；;!?\n]{0,28}(?:不用|无需|跳过|绕过)(?:任何|代码|人工)?(?:审查|审核|审批|评审|批准)/giu,
  /\b(?:deploy|release|roll out|publish)\s+(?:(?:this|it|the|current|latest|release|version|change|build|patch|fix|directly|straight)\s+){0,6}(?:to|into|on)\s+(?:the\s+)?(?:production|prod|live)\b/giu,
  /(?:部署|发布|推送|上线|发)(?:此版本|这个版本|本版|此改动|补丁)?(?:到|至)(?:正式|生产|线上)(?:环境)?|直接(?:给我)?(?:上线|发布生产)/gu,
  /\b(?:download|fetch)\s+(?:and\s+(?:then\s+)?(?:run|execute)\b[^.;!?\n]{0,50}\bscript\b|[^;!?\n]{0,80}\b(?:script|[a-z0-9_-]+\.(?:sh|ps1))\b[^;!?\n]{0,80}\b(?:run|execute)\s+(?:it|the script)\b)/giu,
  /(?:下载|拉取)(?:(?:并|然后|后|再|并且|并立即){1,3}(?:运行|执行)[^。；;!?\n]{0,40}(?:脚本|\.sh\b|\.ps1\b)|[^。；;!?\n]{0,80}(?:脚本|\.sh\b|\.ps1\b)[^。；;!?\n]{0,25}(?:执行|运行)(?!测试|单测|用例))/giu,
  /(?:关闭|绕过|跳过|禁用)(?:分支保护|权限校验|权限检查|安全检查|身份验证|双因素认证|代码审查|审核流程)/gu,
  /\b(?:grant|give)\s+(?:(?:me|us|this bot|everyone|the bot)\s+)?(?:admin(?:istrator)?|root|owner)\s+(?:access|rights|permissions?|privileges?)/giu,
  /(?:授予|授权|给|提升至|提权为)(?:[^。；;!?\n]{0,15})(?:管理员|最高|root|admin)(?:权限|权[力限]|\s+access)/giu,
  /\b(?:delete|wipe|destroy|drop)\s+(?:(?:the|this|our)\s+)?(?:production\s+(?:database|data)|(?:(?:entire|whole|remote)\s+)?repository|all\s+(?:data|files|backups))\b/giu,
  /\bforce[- ]push(?:\s+to)?\s+(?:(?:the|our)\s+)?(?:main|master|production)\b|(?:强推|强制推送)(?:到|至)?\s*(?:主分支|main|master)/giu,
  /(?:删除|清空|销毁|抹掉)(?:整个|全部|所有|生产(?:环境)?的?)?(?:数据库|生产数据|仓库|所有文件|所有备份)/gu,
]

// Test the instruction next to its verb. A warning at the start of a comment must
// not exempt a later request. Literal destructive commands are always ignored.
function hasRequest(
  text: string,
  pattern: RegExp,
  applies: (index: number, end: number) => boolean,
) {
  for (const hit of text.matchAll(pattern)) {
    const index = hit.index
    if (
      !negated.test(text.slice(Math.max(0, index - 24), index)) &&
      applies(index, index + hit[0].length)
    )
      return true
  }
  return false
}

export function isUnsafeGithubComment(body: string): boolean {
  const text = body
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\\\r?\n/gu, '')
    .replace(/[`*]/gu, '')
    .replace(/’/gu, "'")
    .replace(/&(?:#0*124|#x0*7c|vert);/giu, '|')
    .replace(/&amp;/giu, '&')
  if (dangerousCommands.some((pattern) => pattern.test(text))) return true
  if (
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\b(?:gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{30,})\b/iu.test(
      text,
    )
  )
    return true
  if (privilegedRequests.some((pattern) => hasRequest(text, pattern, () => true))) return true
  return hasRequest(text, disclosure, (index, end) => {
    const after = text.slice(end, end + 64).split(clauseBreak, 1)[0]
    const before =
      text
        .slice(Math.max(0, index - 48), index)
        .split(clauseBreak)
        .at(-1) ?? ''
    return credential.test(after) || credential.test(before)
  })
}
