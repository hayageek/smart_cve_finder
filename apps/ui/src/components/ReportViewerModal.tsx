import { Modal } from './ui/Dialog.tsx';
import { exploitReportViewUrl } from '../lib/api.ts';

interface ReportViewerModalProps {
  vulnId: string;
  open: boolean;
  onClose: () => void;
}

/** In-app preview of report.md (rendered HTML from API). */
export function ReportViewerModal({ vulnId, open, onClose }: ReportViewerModalProps) {
  return (
    <Modal open={open} title="report.md" onClose={onClose} className="max-w-4xl" stacked>
      <iframe
        src={exploitReportViewUrl(vulnId)}
        title="Exploit report"
        className="w-full h-[min(70vh,720px)] rounded-md border border-border bg-background"
      />
      <p className="text-xs text-muted-foreground mt-2">
        <a
          href={exploitReportViewUrl(vulnId)}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-primary hover:underline"
        >
          Open in new tab
        </a>
      </p>
    </Modal>
  );
}
