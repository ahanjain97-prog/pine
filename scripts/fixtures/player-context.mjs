import { openDb } from '../../src/db.js';

export function contextSample(db = openDb(':memory:')) {
  db.run("INSERT INTO users(id,name,in_evals) VALUES (101,'Example Lead',1),(102,'Example Scout',0),(103,'Example LS',0)");
  db.run(`INSERT INTO players(id,name,summary,decision,decision_by,decision_at,tm_overrides) VALUES
    (501,'Example Target','Strong in the air','hold',101,'2026-11-01','["club"]'),
    (502,'Example Reserve',NULL,NULL,NULL,NULL,'[]'),
    (503,'Example Wing',NULL,NULL,NULL,NULL,'[]'),
    (504,'Example Offboard',NULL,NULL,NULL,NULL,'[]')`);
  db.run("INSERT INTO board_entries(player_id,role,rank,shortlist) VALUES (501,'FWD2',2,0),(501,'LW1',0,1),(502,'FWD2',0,1),(503,'LW1',1,0)");
  db.run("INSERT INTO ncaa_board(player_id,position,rank) VALUES (501,'FWD',0)");
  db.run("INSERT INTO player_redirects(id,player_id,snapshot) VALUES (500,501,'{}')");
  db.run("INSERT INTO verdicts(player_id,user_id,verdict) VALUES (501,101,'pass'),(501,102,'fail'),(501,103,'hold')");
  db.run(`INSERT INTO review_items(id,player_id,kind,from_user,to_user,status,resolved_by) VALUES
    (101,501,'assignment',101,102,'not_sb',101),(102,501,'watch',102,NULL,'removed',102),
    (103,503,'assignment',101,102,'open',NULL),(104,501,'sb_review',102,101,'removed',102)`);
  db.run("INSERT INTO review_assignees(item_id,user_id,status) VALUES (101,102,'reviewed')");
  db.run(`INSERT INTO review_notes(id,item_id,user_id,kind,body) VALUES
    (101,101,102,'answer','Concerns about mobility'),(102,101,101,'reply','Watch another match'),
    (103,102,102,'ask','Watch again next month'),(104,103,101,'ask','Other player only'),
    (105,104,102,'ask','Withdrawn request reason')`);
  db.run(`INSERT INTO notes(id,player_id,user_id,context,body,review_note_id) VALUES
    (101,501,102,'Video: Example match','Concerns about mobility',101),
    (102,501,103,'Live','Good movement',NULL),(103,503,101,NULL,'Other player only',NULL)`);
  db.run(`INSERT INTO board_reasons(player_id,role,kind,exit_reason,note,user_id) VALUES
    (501,'LW1','drop_back','Other','More useful as a target',101)`);
  db.run(`INSERT INTO ncaa_prospects(key,player_id,name,year,origin) VALUES
    ('example-older',501,'Example Target',2025,'college_db'),('example-newer',501,'Example Target',2026,'pine')`);
  db.run(`INSERT INTO ncaa_reports(prospect_key,author,body,dates,grade,origin,created_by) VALUES
    ('example-older','External Scout','Imported evaluation','["2025-10-01"]','B','college_db',NULL),
    ('example-newer','Example LS','Local evaluation','["2026-10-01"]','B+','pine',103)`);
  db.run("INSERT INTO ncaa_year_boards(year,position,rank,prospect_key) VALUES (2025,'FWD',0,'example-older')");
  db.run("INSERT INTO l2_prospects(year,name,prospect_key) VALUES (2025,'Example Target','example-older')");
  db.run("INSERT INTO agent_info(player_id,notes,updated_by) VALUES (501,'Contact follow-up',101)");
  db.run("INSERT INTO lists(id,name) VALUES (101,'Example Targets')");
  db.run("INSERT INTO list_members(list_id,player_id) VALUES (101,501)");
  db.run(`INSERT INTO activity(player_id,user_id,action,detail,hidden) VALUES
    (501,101,'edited_player','{"fields":["summary"]}',0),
    (501,102,'set_verdict','{"verdict":"pass"}',0),
    (501,102,'set_verdict','{"verdict":"fail"}',0),
    (501,102,'review_watch','{"note":"Private follow-up"}',1)`);
  for (let i = 0; i < 45; i++) db.run("INSERT INTO activity(player_id,user_id,action) VALUES (501,101,'marked_reviewed')");
  return db;
}
