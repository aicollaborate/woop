import { CloudStatusIcon, type CloudStatus } from '@shared/icons/cloud-status-icon';

export type MobileCloudStatus = CloudStatus;

interface MobileCloudStatusIconProps {
  status: MobileCloudStatus;
  className?: string;
}

/**
 * A compact cloud status mark for the mobile list top bar.
 *
 * Use the same Phosphor cloud family across states. Connecting cross-fades
 * through the plain cloud, download, and upload variants so the user reads
 * an active cloud transfer without introducing a second visual language.
 */
export function MobileCloudStatusIcon({ status, className }: MobileCloudStatusIconProps) {
  const classes = ['mobile-cloud-status-icon', `mobile-cloud-status-icon--${status}`, className]
    .filter(Boolean)
    .join(' ');
  return <CloudStatusIcon status={status} className={classes} />;
}
