import { Metadata } from 'next';
import { SnsStudio } from '@gitroom/frontend/components/sns-studio/sns-studio';

export const metadata: Metadata = {
  title: 'SNS Studio',
  description: 'Instagram content preparation and publishing workspace',
};

export default function SnsStudioPage() {
  return <SnsStudio />;
}
