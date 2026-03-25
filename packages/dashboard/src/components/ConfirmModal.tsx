import { useI18n } from '@/lib/i18n';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmClassName?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export function ConfirmModal({
  isOpen,
  title,
  description,
  confirmLabel,
  confirmClassName = 'bg-primary-600 hover:bg-primary-700',
  onConfirm,
  onCancel,
  children,
}: ConfirmModalProps) {
  const { tr } = useI18n();
  const resolvedConfirmLabel = confirmLabel || tr('确认', 'Confirm');
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50" onClick={onCancel}>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <div
          className="glass-strong rounded-xl max-w-md w-full p-6 relative animate-scale-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="glass-modal-header -mx-6 -mt-6 mb-4 px-6 py-4 rounded-t-xl">
            <h3 className="glass-modal-title text-lg font-semibold text-gray-900">{title}</h3>
            {description && (
              <p className="mt-2 text-sm text-gray-600">{description}</p>
            )}
          </div>
          {children && <div className="mt-3">{children}</div>}
          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              {tr('取消', 'Cancel')}
            </button>
            <button
              onClick={onConfirm}
              className={`px-4 py-2 text-sm font-medium text-white rounded-lg ${confirmClassName}`}
            >
              {resolvedConfirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
