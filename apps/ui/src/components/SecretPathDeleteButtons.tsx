import { pathBasename, pathExtension } from '../lib/utils.ts';
import { DeleteSameFilenameSecretsButton } from './DeleteSameFilenameSecretsButton.tsx';
import { DeleteSameExtensionSecretsButton } from './DeleteSameExtensionSecretsButton.tsx';

/** Bulk-delete actions for secrets sharing the same basename or file extension. */
export function SecretPathDeleteButtons({
  filePath,
  onDeleted,
}: {
  filePath: string;
  onDeleted: () => void;
}) {
  const filename = pathBasename(filePath);
  const extension = pathExtension(filePath);

  return (
    <>
      {filename && (
        <DeleteSameFilenameSecretsButton filename={filename} onDeleted={onDeleted} />
      )}
      {extension && (
        <DeleteSameExtensionSecretsButton extension={extension} onDeleted={onDeleted} />
      )}
    </>
  );
}
