import { useRef } from "react";

import type { PromptImage } from "../../../threads/model";
import { Icon } from "../../icon";

export const ImagePreview = ({
  image,
  thumbnailAlt,
}: {
  image: PromptImage;
  thumbnailAlt: string;
}): React.JSX.Element => {
  const dialog = useRef<HTMLDialogElement>(null);
  const source = `data:${image.mimeType};base64,${image.data}`;
  return (
    <>
      <button
        className="image-preview-trigger"
        title="Open attached image"
        onClick={() => dialog.current?.showModal()}
      >
        <img alt={thumbnailAlt} src={source} />
      </button>
      <dialog
        aria-label="Attached image"
        className="image-preview-dialog"
        ref={dialog}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            event.currentTarget.close();
          }
        }}
      >
        <button
          aria-label="Close attached image"
          className="image-preview-close"
          onClick={() => dialog.current?.close()}
        >
          <Icon className="image-preview-close-icon" kind="x" title="Close" />
        </button>
        <img alt="Attached" src={source} />
      </dialog>
    </>
  );
};
