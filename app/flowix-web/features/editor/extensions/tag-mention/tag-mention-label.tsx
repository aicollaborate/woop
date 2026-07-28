interface TagPathPart {
  text: string;
  separator: boolean;
}

export function splitTagPath(name: string): TagPathPart[] {
  return name
    .split(/(\/)/)
    .filter(Boolean)
    .map((text) => ({ text, separator: text === '/' }));
}

export function TagMentionName({ name }: { name: string }) {
  return (
    <span className="mention-tag-name">
      <span className="mention-tag-name-content">
        {splitTagPath(name).map((part, index) => (
          <span
            key={`${index}:${part.text}`}
            className={part.separator ? 'mention-tag-separator' : 'mention-tag-segment'}
          >
            {part.text}
          </span>
        ))}
      </span>
    </span>
  );
}

export function appendTagMentionName(container: HTMLElement, name: string): void {
  const content = document.createElement('span');
  content.className = 'mention-tag-name-content';
  for (const part of splitTagPath(name)) {
    const element = document.createElement('span');
    element.className = part.separator ? 'mention-tag-separator' : 'mention-tag-segment';
    element.textContent = part.text;
    content.append(element);
  }
  container.append(content);
}
