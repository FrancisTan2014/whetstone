import { motion } from "framer-motion";

import { motionSprings, withReducedMotion } from "../motion/motion.js";

export type ToastProps = Readonly<{
  message: string;
  prefersReducedMotion: boolean;
}>;

// A transient status message that springs in. It announces politely (role="status") and
// honors reduced motion (instant, no slide) while still showing the message.
export function Toast({ message, prefersReducedMotion }: ToastProps): React.JSX.Element {
  return (
    <motion.p
      animate={{ opacity: 1, y: 0 }}
      className="readerToast"
      initial={{ opacity: 0, y: 8 }}
      role="status"
      transition={withReducedMotion(motionSprings.snappy, prefersReducedMotion)}
    >
      {message}
    </motion.p>
  );
}
