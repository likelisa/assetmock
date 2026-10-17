import {test,expect} from '@playwright/test';
import Database from 'better-sqlite3';
for(const target of ['car','home'] as const) test(`原游戏到结局样本 · ${target}`,async({page})=>{
 await page.goto('/?view=planning&planningTab=scenarios');
 await page.getByRole('button',{name:target==='car'?/买一辆自己的车/:/拥有一个自己的家/}).click();
 await page.getByRole('button',{name:target==='car'?'选择林舟':'选择可全款型'}).click();
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'确认方案，开始人生'}).click();
 await expect(page.getByTestId('v2-month')).toHaveText('0');
 await expect(page.getByRole('region',{name:'本局多世界分析'})).toHaveCount(0);
 if(target==='home'){let failed=false;await page.route('**/worldline-analysis',async route=>{if(route.request().method()==='POST'&&!failed){failed=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'样本计算暂时失败'})});}else await route.continue();});}
 const id=await page.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('life-integrated:'));return key?localStorage.getItem(key):null;});expect(id).toBeTruthy();
 const db=new Database('./.local-data/e2e/game.sqlite');
 try{const row=db.prepare('SELECT body FROM v2_runs WHERE id=?').get(id) as {body:string};const run=JSON.parse(row.body);run.tape=Array.from({length:run.setup.rules.months},()=>({medical:999999,jobLoss:999999,bonusDelay:999999,marketDrop:999999,career:999999}));db.prepare('UPDATE v2_runs SET body=? WHERE id=?').run(JSON.stringify(run),id);}finally{db.close();}
 const steps=target==='car'?[1,2,3,6,9,12,24,36,48,60]:[3,6,9,12,24,36,48,60,120,180,240,300,360];
 for(const month of steps){await page.getByRole('button',{name:/继续人生 · 最多到第/}).click();await expect(page.getByTestId('v2-month')).toHaveText(String(month));}
 const analysis=page.getByRole('region',{name:'本局多世界分析'});
 if(target==='home'){await expect(analysis.getByRole('alert')).toContainText('样本计算暂时失败');await expect(page.getByRole('heading',{name:'这一次，你付出与留下了什么'})).toBeVisible();await analysis.getByRole('button',{name:'重试分析'}).click();}
 await expect(analysis.getByText(/200 个样本出现资金缺口/).first()).toBeVisible();
 await analysis.getByText('展开样本与分析',{exact:true}).click();await expect(analysis.getByRole('heading',{name:'最低可用资金分布'})).toBeVisible();
 const text=await analysis.locator('strong').allTextContents();
 await page.reload();await expect(analysis.locator('strong')).toHaveText(text);
 await analysis.getByText('展开样本与分析',{exact:true}).click();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`test-results/ending-${target}.png`,fullPage:true});
 await expect(page.getByRole('button',{name:'自己修改方案重玩'})).toBeVisible();
});
