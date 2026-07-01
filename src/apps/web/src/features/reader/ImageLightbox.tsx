import * as Dialog from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "framer-motion";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion.js";

export type ImageLightboxProps = Readonly<{
  alt: string;
  // The figure's caption (plain text), shown beneath the enlarged image when present.
  caption: string;
  // Runtime image-load failure on the inline trigger image; the figure then degrades to caption-only.
  onError: () => void;
  src: string;
}>;

// A view-only image lightbox (#334): the figure image is a real focusable button that opens a centered,
// fit-to-viewport modal over a dimmed + blurred backdrop, so dense diagrams (e.g. a replication figure)
// are legible beyond the reading-column width. Built on `@radix-ui/react-dialog` (focus trap, Escape +
// backdrop-click dismissal, body scroll-lock, portal, ARIA labelling, and focus-return to the trigger
// on close); the SAME modal opens on a desktop click and a mobile tap. Being a `<button>`, the trigger
// is already in the reading-area tap ignore-list, so a figure tap opens the lightbox instead of toggling
// chrome. Motion is tokenized and honors reduced motion. No route change and no server call — the same
// cached `/api/images/:id` bytes render enlarged.
export function ImageLightbox({
  alt,
  caption,
  onError,
  src
}: ImageLightboxProps): React.JSX.Element {
  const prefersReducedMotion = Boolean(useReducedMotion());
  // Under reduced motion `withReducedMotion` returns an instant (duration-0) transition, so the fade +
  // slight scale-in snaps into place with no animation — honoring criterion 7 without a separate motion
  // shape to branch on.
  const transition = withReducedMotion(motionSprings.gentle, prefersReducedMotion);
  const triggerLabel = alt.trim().length > 0 ? `View larger: ${alt}` : "View image larger";
  const dialogLabel = alt.trim().length > 0 ? alt : "Enlarged image";
  const hasCaption = caption.trim().length > 0;

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button aria-label={triggerLabel} className="readerFigureTrigger" type="button">
          <img
            alt={alt}
            className="readerFigureImage"
            draggable={false}
            loading="lazy"
            onError={onError}
            src={src}
          />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="lightbox-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          aria-label={dialogLabel}
          asChild
          className="lightbox-content"
        >
          <motion.div
            animate={{ opacity: 1, scale: 1 }}
            initial={{ opacity: 0, scale: 0.96 }}
            transition={transition}
          >
            <Dialog.Close aria-label="Close" className="lightbox-close" type="button">
              ✕
            </Dialog.Close>
            <img alt={alt} className="lightbox-image" src={src} />
            {hasCaption ? <p className="lightbox-caption">{caption}</p> : null}
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
