import { useMutation, useQuery } from '@tanstack/react-query'
import type {
  MandateArchive,
  MandatePlatform,
  MandateTarget,
  TriggerMandate,
} from '@zero-os/shared'
import { apiFetch, apiPost } from '../lib/api'
import { type BoundOption, BoundTargetSelect } from './config-bound-target'
import { mandateDestinations } from './mandate-policy-fields'

const base = '/api/listeners/mandates'
const platforms: MandatePlatform[] = ['weixin', 'feishu', 'dingtalk']
export function MandateTargets({
  value,
  onChange,
}: { value: TriggerMandate; onChange: (patch: Partial<TriggerMandate>) => void }) {
  const choices = useQuery({
    queryKey: ['listeners', 'mandates', 'targets'],
    queryFn: ({ signal }) =>
      apiFetch<{
        targets: BoundOption[]
        archiveChannels: Array<{ channelId: string; label: string }>
      }>(`${base}/targets`, { signal }),
    retry: false,
  })
  const verify = useMutation({
    mutationFn: (archive: MandateArchive) =>
      apiPost<{ writable: boolean }>(`${base}/documents/verify`, archive),
  })
  function updateTarget(platform: MandatePlatform, target: MandateTarget | null) {
    const rest = value.targets.filter((entry) => entry.platform !== platform)
    onChange({ targets: target ? [...rest, target] : rest })
  }
  const savedArchive = value.archive
  const currentVerification =
    savedArchive &&
    savedArchive.channelId === verify.variables?.channelId &&
    savedArchive.documentId === verify.variables?.documentId
  return (
    <div className="listener-stack">
      <div className="listener-actions">
        <p className="listener-muted">
          为此委托单独选择可接收提醒的会话。每个平台可选一个目标，飞书和钉钉按已验证的会话和操作人绑定。
        </p>
        <button type="button" onClick={() => void choices.refetch()} disabled={choices.isFetching}>
          刷新已绑定目标
        </button>
      </div>
      {choices.isLoading && <small>正在读取已绑定的目标…</small>}
      {choices.error && (
        <p className="listener-error" role="alert">
          {choices.error.message}
        </p>
      )}
      <div className="listener-fields">
        {platforms.map((platform) => (
          <BoundTargetSelect
            key={platform}
            platform={platform}
            label={`${mandateDestinations[platform]}接收会话`}
            emptyLabel="未授权"
            selected={value.targets.find((target) => target.platform === platform)}
            targets={choices.data?.targets}
            onChange={(target) => updateTarget(platform, target)}
          />
        ))}
      </div>
      <label className="listener-row">
        <input
          type="checkbox"
          checked={!!savedArchive}
          onChange={(e) =>
            onChange({ archive: e.target.checked ? { channelId: '', documentId: '' } : null })
          }
        />
        同时归档到指定飞书文档
      </label>
      {savedArchive && (
        <>
          <div className="listener-fields">
            <label className="listener-field">
              归档用飞书账号
              <select
                value={savedArchive.channelId}
                onChange={(e) =>
                  onChange({ archive: { ...savedArchive, channelId: e.target.value } })
                }
              >
                <option value="">选择账号…</option>
                {savedArchive.channelId &&
                  !choices.data?.archiveChannels.some(
                    (channel) => channel.channelId === savedArchive.channelId,
                  ) && <option value={savedArchive.channelId}>{savedArchive.channelId}</option>}
                {choices.data?.archiveChannels.map((channel) => (
                  <option key={channel.channelId} value={channel.channelId}>
                    {channel.label} · {channel.channelId}
                  </option>
                ))}
              </select>
            </label>
            <label className="listener-field">
              飞书文档 ID
              <input
                value={savedArchive.documentId}
                placeholder="docx 链接末尾的文档 ID"
                onChange={(e) =>
                  onChange({ archive: { ...savedArchive, documentId: e.target.value.trim() } })
                }
              />
            </label>
          </div>
          <div className="listener-row">
            <button
              type="button"
              disabled={
                !savedArchive.channelId ||
                !/^[A-Za-z0-9]{1,128}$/.test(savedArchive.documentId) ||
                verify.isPending
              }
              onClick={() => verify.mutate(savedArchive)}
            >
              检查文档写权限
            </button>
            {verify.isPending && <small>检查中…</small>}
            {currentVerification && verify.isSuccess && (
              <output>
                {verify.data.writable
                  ? '此账号可写入该文档'
                  : '未能核实此账号的文档写权限，请检查授权和连接。'}
              </output>
            )}
            {currentVerification && verify.error && (
              <p role="alert" className="listener-error">
                {verify.error.message}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
