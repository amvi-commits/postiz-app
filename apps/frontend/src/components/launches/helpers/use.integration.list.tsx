'use client';

import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useCallback } from 'react';
import useSWR from 'swr';

export const useIntegrationList = (organizationId?: string) => {
  const fetch = useFetch();

  const load = useCallback(async (key: string | [string, string]) => {
    const response = await fetch(Array.isArray(key) ? key[1] : key);
    if (!response.ok) throw new Error('接続済みアカウントを取得できませんでした。');
    const data = await response.json();
    if (!Array.isArray(data.integrations)) throw new Error('投稿先一覧の応答を確認できませんでした。');
    return data.integrations;
  }, [fetch]);

  return useSWR(organizationId ? [organizationId, '/integrations/list'] : '/integrations/list', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    fallbackData: [],
  });
};
