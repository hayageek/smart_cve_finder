import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils.ts';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({
      top: rect.top - 8,
      left: rect.left + rect.width / 2,
    });
  }, []);

  const show = useCallback(() => {
    updatePosition();
    setVisible(true);
  }, [updatePosition]);

  const hide = useCallback(() => {
    setVisible(false);
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        className={cn('inline-flex items-center justify-center', className)}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {visible && createPortal(
        <span
          role="tooltip"
          style={{ top: position.top, left: position.left, transform: 'translate(-50%, -100%)' }}
          className="fixed z-[100] pointer-events-none whitespace-nowrap rounded-md border border-border bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md"
        >
          {content}
        </span>,
        document.body,
      )}
    </>
  );
}
