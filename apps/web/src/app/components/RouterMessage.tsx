import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './RouterMessage.css'

/** Display the original answer without rewriting, truncating, or inferring task state. */
export function RouterMessage({ text }: { text: string }) {
  return (
    <div className="rw-answer router-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          // Model text must not initiate image requests to third-party hosts.
          img: ({ src, alt }) =>
            src ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                查看图片：{alt || '图片'}
              </a>
            ) : null,
          pre: ({ children }) => (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Let keyboard users scroll long code lines.
            <pre tabIndex={0} aria-label="代码示例">{children}</pre>
          ),
          table: ({ children }) => (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll this table region.
            <section className="router-message-table" aria-label="表格，可横向滚动" tabIndex={0}>
              <table>{children}</table>
            </section>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
