import {mountProjectViews} from './project-view.mjs';
import {createProjectDetail} from './project-detail.mjs';
// Compose original V7 containers without activating any demo script.
export async function mountProjects(document,send,actions){
 const detail=createProjectDetail(document,send,actions);let disposed=false;
 const open=id=>detail.open(id).catch(error=>{if(!disposed)actions.onError(error)});
 try{const views=await mountProjectViews(document,send,open);return {open,dispose(){disposed=true;views.dispose();detail.dispose();}};}
 catch(error){detail.dispose();throw error;}
}
