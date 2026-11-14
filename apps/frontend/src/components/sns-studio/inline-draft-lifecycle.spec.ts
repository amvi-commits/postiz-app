/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);
const mockFetch=jest.fn();
let mockProps:any;
let mockAccounts:any;
let mockIntegrations:any;
jest.mock('@gitroom/helpers/utils/custom.fetch',()=>({useFetch:()=>mockFetch}));
jest.mock('@gitroom/frontend/components/layout/user.context',()=>({useUser:()=>({orgId:'lifecycle-org'})}));
jest.mock('swr',()=>({__esModule:true,default:([,path]:string[])=>({data:path==='/threads-studio/accounts'?mockAccounts:mockIntegrations,isLoading:false})}));
jest.mock('@gitroom/frontend/components/launches/calendar.context',()=>({CalendarWeekProvider:({children}:any)=>children}));
jest.mock('@gitroom/frontend/components/layout/set.timezone',()=>({newDayjs:()=>require('dayjs')()}));
// Keep the real AddEditModal, ExistingData context and scoped store. Only the
// executor/visual leaves are replaced; mount/cleanup/initialization are real.
jest.mock('@gitroom/frontend/components/new-launch/manage.modal',()=>({ManageModal:(props:any)=>{
  const {useLaunchStore}=require('@gitroom/frontend/components/new-launch/store');
  const selected=useLaunchStore((s:any)=>s.selectedIntegrations);
  const internal=useLaunchStore((s:any)=>s.internal);
  mockProps=props;
  return React.createElement('output',null,JSON.stringify({selected:selected.map((s:any)=>s.integration.id),posts:internal.flatMap((s:any)=>s.integrationValue)}));
}}));
import { ThreadsComposer } from './threads/threads-composer';

it('initializes each saved draft in a fresh store across repeated saves and a page remount',async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  localStorage.clear();localStorage.setItem('sns-studio:threads-composer:lifecycle-org:selection','threads-one');
  const integration={id:'threads-one',name:'Fixture',identifier:'threads'};
  mockAccounts=[{id:integration.id,name:integration.name,transport:'browser',browserAccount:'fixture',publishBlockedReason:'Locked'}];
  mockIntegrations={integrations:[integration]};
  let saved:any={integration:integration.id,group:'server-group-1',settings:{browserAccount:'fixture'},posts:[{id:'same-post-id',state:'DRAFT',content:'Saved one',delay:0,image:[{id:'media',path:'/uploads/one.mp4'}],publishDate:'2026-12-01T00:00:00Z'}]};
  mockFetch.mockReset();mockFetch.mockImplementation(async()=>({ok:true,json:async()=>saved}));
  const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
  const values=()=>JSON.parse(container.querySelector('output')!.textContent!);
  try{
    await act(async()=>root.render(React.createElement(ThreadsComposer)));
    expect(values().selected).toEqual(['threads-one']);
    await act(async()=>mockProps.onPosted({type:'draft',group:'client-proposal',items:[{postId:'same-post-id'}]}));
    expect(values()).toMatchObject({selected:['threads-one'],posts:[{id:'same-post-id',content:'<p>Saved one</p>',media:[{id:'media'}]}]});
    saved={...saved,group:'server-group-2',posts:[{...saved.posts[0],content:'Saved two'}]};
    await act(async()=>mockProps.onPosted({type:'draft',group:'server-group-1',items:[{postId:'same-post-id'}]}));
    expect(values().posts).toHaveLength(1);expect(values().posts[0]).toMatchObject({id:'same-post-id',content:'<p>Saved two</p>',media:[{id:'media'}]});
    await act(async()=>root.render(null));
    await act(async()=>root.render(React.createElement(ThreadsComposer)));
    expect(values().selected).toEqual(['threads-one']);expect(values().posts).toHaveLength(1);expect(values().posts[0].id).toBe('same-post-id');
    expect(mockFetch.mock.calls.map(([url])=>url)).toEqual(['/posts/same-post-id','/posts/same-post-id','/posts/same-post-id']);
  }finally{await act(async()=>root.unmount());container.remove();localStorage.clear();delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
