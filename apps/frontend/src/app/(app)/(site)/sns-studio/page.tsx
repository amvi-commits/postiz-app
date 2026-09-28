import { Metadata } from 'next';
import { SnsStudio } from '@gitroom/frontend/components/sns-studio/sns-studio';

export const metadata: Metadata = {
  title: 'SNS Studio',
  description: 'Shared social content production and publishing workspace',
};

export default function SnsStudioPage() {
  return <SnsStudio />;
}
