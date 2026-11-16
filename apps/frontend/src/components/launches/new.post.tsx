import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import dayjs from 'dayjs';
import { useCalendar } from '@gitroom/frontend/components/launches/calendar.context';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { SetSelectionModal } from '@gitroom/frontend/components/launches/calendar';
import { AddEditModal } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import type { AddEditModalProps } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { ModalWrapperComponent } from '@gitroom/frontend/components/new-launch/modal.wrapper.component';

export const NewPost = (props: {
  onlyValues?: AddEditModalProps['onlyValues'];
  onlyValuesByIntegration?: AddEditModalProps['onlyValuesByIntegration'];
  selectedChannels?: string[];
  selectedChannelSettings?: AddEditModalProps['selectedChannelSettings'];
  scheduledAtByIntegration?: AddEditModalProps['scheduledAtByIntegration'];
  commonContentPlanId?: AddEditModalProps['commonContentPlanId'];
  onBeforePost?: AddEditModalProps['onBeforePost'];
  onPosted?: AddEditModalProps['onPosted'];
  date?: dayjs.Dayjs;
  label?: string;
  disabled?: boolean;
  beforeOpen?: () => Promise<Pick<AddEditModalProps, 'commonContentPlanId' | 'onBeforePost' | 'onPosted'>>;
} = {}) => {
  const fetch = useFetch();
  const modal = useModals();
  const { integrations, reloadCalendarView, sets } = useCalendar();
  const t = useT();
  const toaster = useToaster();
  const opening = useRef(false);
  const [isOpening, setIsOpening] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const createAPost = useCallback(async () => {
    if (opening.current) return;
    opening.current = true; setIsOpening(true);
    try {
    const configured = { ...props, ...(await props.beforeOpen?.()) };
    if (!active.current) return;
    const date =
      configured.date ||
      dayjs.utc((await (await fetch('/posts/find-slot')).json()).date).local();

    const set: any = configured.onlyValues?.length || !sets.length
      ? undefined
      : await new Promise((resolve) => {
          modal.openModal({
            title: t('select_set', 'Select a Set'),
            closeOnClickOutside: true,
            closeOnEscape: true,
            withCloseButton: false,
            onClose: () => resolve('exit'),
            classNames: {
              modal: 'text-textColor',
            },
            children: (
              <SetSelectionModal
                sets={sets}
                onSelect={(selectedSet) => {
                  resolve(selectedSet);
                  modal.closeAll();
                }}
                onContinueWithoutSet={() => {
                  resolve(undefined);
                  modal.closeAll();
                }}
              />
            ),
          });
        });

    if (set === 'exit' || !active.current) return;

    modal.openModal({
      id: 'add-edit-modal',
      closeOnClickOutside: false,
      removeLayout: true,
      closeOnEscape: false,
      withCloseButton: false,
      askClose: true,
      fullScreen: true,
      classNames: {
        modal: 'w-[100%] max-w-[1400px] text-textColor',
      },
      children: (
        <AddEditModal
          allIntegrations={integrations.map((p) => ({
            ...p,
          }))}
          {...(set?.content ? { set: JSON.parse(set.content) } : {})}
          {...(configured.onlyValues ? { onlyValues: configured.onlyValues } : {})}
          {...(configured.onlyValuesByIntegration ? { onlyValuesByIntegration: configured.onlyValuesByIntegration } : {})}
          {...(configured.selectedChannels ? { selectedChannels: configured.selectedChannels } : {})}
          {...(configured.selectedChannelSettings ? { selectedChannelSettings: configured.selectedChannelSettings } : {})}
          {...(configured.scheduledAtByIntegration ? { scheduledAtByIntegration: configured.scheduledAtByIntegration } : {})}
          {...(configured.commonContentPlanId ? { commonContentPlanId: configured.commonContentPlanId } : {})}
          {...(configured.onBeforePost ? { onBeforePost: configured.onBeforePost } : {})}
          {...(configured.onPosted ? { onPosted: configured.onPosted } : {})}
          reopenModal={createAPost}
          mutate={reloadCalendarView}
          integrations={integrations}
          date={date}
        />
      ),
      size: '80%',
      title: ``,
    });
    } catch (error) {
      if (active.current) toaster.show(error instanceof Error ? error.message : '投稿画面を準備できませんでした。', 'warning');
    } finally { opening.current = false; if (active.current) setIsOpening(false); }
  }, [
    integrations,
    sets,
    props.onlyValues,
    props.onlyValuesByIntegration,
    props.selectedChannels,
    props.selectedChannelSettings,
    props.scheduledAtByIntegration,
    props.commonContentPlanId,
    props.onBeforePost,
    props.onPosted,
    props.date,
    props.beforeOpen,
  ]);
  return (
    <button
      onClick={createAPost}
      disabled={props.disabled || isOpening}
      className="text-white flex-1 pt-[12px] pb-[14px] ps-[16px] pe-[20px] group-[.sidebar]:p-0 min-h-[44px] max-h-[44px] rounded-md bg-btnPrimary flex justify-center items-center gap-[5px] outline-none"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="21"
        height="20"
        viewBox="0 0 21 20"
        fill="none"
        className="min-w-[21px] min-h-[20px]"
      >
        <path
          d="M10.5001 4.16699V15.8337M4.66675 10.0003H16.3334"
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex-1 text-start text-[14px] group-[.sidebar]:hidden">
        {props.label || t('create_new_post', 'Create Post')}
      </div>
    </button>
  );
};
