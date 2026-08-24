import { useState } from "react";
import { Check, Copy, File } from "lucide-react";
import { attachmentDisplayName } from "@/lib/chat-message";

export function UserAttachments({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  return (
    <ul className="mt-2 flex min-w-0 max-w-full flex-col gap-1">
      {paths.map((path) => (
        <AttachmentChip key={path} path={path} />
      ))}
    </ul>
  );
}

function AttachmentChip({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const name = attachmentDisplayName(path);
  const copy = () => {
    void navigator.clipboard?.writeText(path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <li className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg bg-raised/60 px-2 py-1">
      <File size={13} className="shrink-0 text-ink-secondary" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={path}>
        {name}
      </span>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
        title={`Copy path: ${path}`}
        aria-label={`Copy path ${name}`}
      >
        {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      </button>
    </li>
  );
}
