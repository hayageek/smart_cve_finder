import { Modal, REPORT_VIEWER_MODAL_SIZE_KEY } from './ui/Dialog.tsx';
import { exploitReportViewUrl } from '../lib/api.ts';

interface ReportViewerModalProps {
  vulnId: string;
  open: boolean;
  onClose: () => void;
}

/** In-app preview of report.md (rendered HTML from API). */
export function ReportViewerModal({ vulnId, open, onClose }: ReportViewerModalProps) {
  return (
    <Modal
      open={open}
      title="report.md"
      onClose={onClose}
      stacked
      resizable
      sizeStorageKey={REPORT_VIEWER_MODAL_SIZE_KEY}
      defaultSize={{ width: 896, height: 720 }}
    >
      <div className="flex flex-col flex-1 min-h-0 gap-2">
        <iframe
          src={exploitReportViewUrl(vulnId)}
          title="Exploit report"
          className="w-full flex-1 min-h-[280px] rounded-md border border-border bg-background"
        />
        <p className="text-xs text-muted-foreground shrink-0">
          <a
            href={exploitReportViewUrl(vulnId)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-primary hover:underline"
          >
            Open in new tab
          </a>
        </p>
      </div>
    </Modal>
  );
}
