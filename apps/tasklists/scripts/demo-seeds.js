export const PROTOTYPE_TASK_TEXTS = [
  "Refill the bird feeder before the sparrows file another formal request.",
  "Check the fridge light still turns off, preferably without crawling inside again.",
  "Return the umbrella to the hallway, where it insists it lives.",
  "Water the fern before it submits another strongly worded letter to the radiator.",
  "Update the shopping list to include milk, bread, and a moderately sensible hat.",
  "Verify that the kettle boils water and not, as it occasionally attempts, good intentions.",
  "Organize the cutlery drawer so the forks don't keep holding union meetings.",
  "Empty the dishwasher before it begins drafting poetry about neglect.",
  "Set the alarm clock, reminding it gently that no one enjoys its personality.",
  "Take the bins out, though they are increasingly insistent they'd rather stay in.",
  "Test the smoke detector by asking it politely to explain its worldview.",
  "Send an email to the electricity meter thanking it for its tireless blinking.",
  "Sharpen pencils so they feel prepared for anything, including international diplomacy.",
  "Update the calendar to reflect the current year, not the one the cat prefers.",
  "Polish the windows until they are clear about their long-term career goals.",
  "Check the washing machine for socks that have declared independence.",
  "Restock the biscuit tin before negotiations with visitors turn awkward.",
  "Feed the goldfish, who has recently taken to sighing at odd intervals.",
  "Write down the Wi-Fi password in case it decides to change its name again.",
  "Vacuum the carpet before it develops further geological features.",
];

export const WEEKEND_PROJECT_TEXTS = [
  "Patch the garden fence before the neighbor's cat launches another inspection.",
  "Clear the garage path so the bikes stop living under a tarp monarchy.",
  "Label the mystery cables basket before it becomes household folklore.",
  "Sand the coffee table so splinters stop campaigning for attention.",
  "Plan the herb bed before the mint declares full sovereignty.",
  "Paint the hallway sample squares to convince the walls to commit.",
  "Wash the car until it remembers it's actually blue.",
  "Tighten the wobbly chairs before guests develop sea legs.",
  "Test the fire pit so marshmallows can renew their contract.",
  "Replace the porch light bulb before the moth council files grievances.",
  "Organize board games so the dice stop backpacking through the house.",
  "Clean the aquarium filter before the fish union organizes a strike.",
  "Inventory the toolbox to confirm the 14mm socket still exists.",
  "Fix the squeaky door that narrates every midnight snack.",
  "Trim the hedges before they audition as stage curtains.",
  "Sort camping gear into piles of 'useful' and 'optimistic'.",
  "Re-string the clothesline before the laundry takes flight.",
  "Tune the piano so middle C stops sounding philosophical.",
  "Swap batteries in the fairy lights before they become existential.",
  "Back up family photos before the cloud picks favorites.",
];

export const WORK_FOLLOWUP_TEXTS = [
  "Email the design draft to Isla before the mockups develop sentience.",
  "Confirm sprint goals with DevOps so the servers stay optimistic.",
  "Schedule the retro while memories of the bugs are still polite.",
  "Review the analytics deck before stakeholders wield highlighters.",
  "Update the roadmap to reflect the features marketing already announced.",
  "Ping legal about the release notes before we ship interpretive poetry.",
  "Organize user interviews so transcripts arrive before next quarter.",
  "Check in with QA about flaky tests that believe in free will.",
  "Draft the onboarding doc so newcomers stop learning via treasure hunt.",
  "Refresh the team wiki links that redirect to archaeological findings.",
  "Finalize the budget sheet before finance asks for interpretive dance.",
  "Reply to the vendor with polite enthusiasm and three clarifying bullets.",
  "Plan a knowledge share on the feature nobody admits to understanding.",
  "Pair with analytics to translate dashboards into mortal speech.",
  "Collect status updates without summoning another mega-thread.",
  "Approve the icon set before UI sneaks in mysterious hieroglyphs.",
  "Prep the release checklist so launch day doesn't improvise.",
  "Ask security about the alert that keeps waving politely.",
  "Sync with support on the ticket queue before it becomes folklore.",
  "Send a kudos round-up so everyone remembers we're on the same team.",
];

export const createSeedItems = (slug, texts) =>
  texts.map((text, index) => ({
    id: `${slug}-task-${index + 1}`,
    text,
    done: false,
  }));

export const PROTOTYPE_TASK_LIST = {
  id: "list-prototype",
  title: "Prototype Tasks",
  items: createSeedItems("prototype", PROTOTYPE_TASK_TEXTS),
};

export const WEEKEND_PROJECT_LIST = {
  id: "list-weekend",
  title: "Weekend Projects",
  items: createSeedItems("weekend", WEEKEND_PROJECT_TEXTS),
};

export const WORK_FOLLOWUP_LIST = {
  id: "list-work",
  title: "Work Follow-ups",
  items: createSeedItems("work", WORK_FOLLOWUP_TEXTS),
};

export const SEED_LIST_CONFIGS = [
  PROTOTYPE_TASK_LIST,
  WEEKEND_PROJECT_LIST,
  WORK_FOLLOWUP_LIST,
];
