'use client';

import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useCallback } from 'react';
import useSWR from 'swr';

export const useIntegrationList = () => {
  const fetch = useFetch();
  const user = useUser();

  const load = useCallback(async (path: string) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error('接続済みアカウントを取得できませんでした。');
    return (await response.json()).integrations;
  }, []);

  return useSWR(['/integrations/list', user?.orgId], ([path]) => load(path), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    fallbackData: [],
  });
};