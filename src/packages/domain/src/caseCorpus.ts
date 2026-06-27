// The authored content substrate for the language coach: a map of everyday-life DOMAINS, each
// holding CASES (a situation + the communicative function it serves), each carrying a pre-cooked
// inventory of CHUNKS (the native phrasings to practise). This is hand-authored shared content —
// the small seed corpus that makes the practice loop usable before any LLM authoring exists. It is
// pure data (no persistence, network, or UI): the server seeds it into the database from here, the
// same way note templates are seeded from their canonical domain definition.

export type CorpusChunk = Readonly<{
  // Stable id; doubles as the seed primary key, so it is namespaced under its case.
  id: string;
  // The target phrasing / collocation / idiom — the unit of practice.
  text: string;
  // Optional short meaning gloss.
  gloss?: string;
  // Optional note on when/how to use it.
  usageNote?: string;
}>;

export type CorpusCase = Readonly<{
  // Stable id; doubles as the seed primary key, so it is namespaced under its domain.
  id: string;
  // The everyday situation this case covers.
  situation: string;
  // The communicative function the situation serves (what the speaker is trying to do).
  communicativeFunction: string;
  chunks: ReadonlyArray<CorpusChunk>;
}>;

export type CorpusDomain = Readonly<{
  // Stable id (a slug); doubles as the seed primary key.
  id: string;
  // Human-readable label.
  name: string;
  // Frequency / importance weight in [0, 1]: how much of everyday life this domain covers, used to
  // prioritise practice. Higher means more central.
  weight: number;
  cases: ReadonlyArray<CorpusCase>;
}>;

function freezeChunk(chunk: CorpusChunk): CorpusChunk {
  return Object.freeze({ ...chunk });
}

function freezeCase(theCase: CorpusCase): CorpusCase {
  return Object.freeze({
    ...theCase,
    chunks: Object.freeze(theCase.chunks.map(freezeChunk))
  });
}

function freezeDomain(domain: CorpusDomain): CorpusDomain {
  return Object.freeze({
    ...domain,
    cases: Object.freeze(domain.cases.map(freezeCase))
  });
}

const corpusDefinitions: ReadonlyArray<CorpusDomain> = [
  {
    id: "kitchen",
    name: "Kitchen & cooking",
    weight: 0.9,
    cases: [
      {
        id: "kitchen.meal_planning",
        situation: "Deciding what to cook for a meal",
        communicativeFunction: "Proposing and negotiating a plan",
        chunks: [
          { id: "kitchen.meal_planning.whats_for_dinner", text: "What are we having for dinner?" },
          {
            id: "kitchen.meal_planning.feel_like",
            text: "I feel like something light tonight.",
            gloss: "I'm in the mood for a light meal."
          },
          { id: "kitchen.meal_planning.how_about", text: "How about we do pasta?" },
          {
            id: "kitchen.meal_planning.use_up",
            text: "We should use up the vegetables before they go off.",
            usageNote: '"go off" = spoil (British-leaning but widely understood).'
          },
          {
            id: "kitchen.meal_planning.im_easy",
            text: "I'm easy — whatever you fancy.",
            gloss: "I don't mind; your choice."
          },
          { id: "kitchen.meal_planning.order_in", text: "Should we just order in instead?" },
          {
            id: "kitchen.meal_planning.defrost",
            text: "I'll take something out of the freezer to defrost."
          }
        ]
      },
      {
        id: "kitchen.at_the_table",
        situation: "Offering and sharing food at the table",
        communicativeFunction: "Offering, accepting, and declining politely",
        chunks: [
          {
            id: "kitchen.at_the_table.help_yourself",
            text: "Help yourself.",
            usageNote: "A warm, standard invitation to take food."
          },
          {
            id: "kitchen.at_the_table.dig_in",
            text: "Dig in while it's hot.",
            gloss: "Start eating."
          },
          { id: "kitchen.at_the_table.pass_the", text: "Could you pass the salt?" },
          {
            id: "kitchen.at_the_table.seconds",
            text: "Would you like seconds?",
            gloss: "a second helping"
          },
          {
            id: "kitchen.at_the_table.im_stuffed",
            text: "I'm stuffed, thanks.",
            gloss: "I'm very full."
          },
          { id: "kitchen.at_the_table.bit_more", text: "Just a little bit more, please." },
          { id: "kitchen.at_the_table.my_compliments", text: "My compliments to the chef!" }
        ]
      },
      {
        id: "kitchen.cooking_in_progress",
        situation: "Talking through cooking as it happens",
        communicativeFunction: "Describing an action in progress and asking for help",
        chunks: [
          {
            id: "kitchen.cooking_in_progress.keep_an_eye",
            text: "Can you keep an eye on the stove?",
            gloss: "watch it for me"
          },
          { id: "kitchen.cooking_in_progress.simmer", text: "Let it simmer for ten minutes." },
          {
            id: "kitchen.cooking_in_progress.give_a_stir",
            text: "Give it a stir now and then.",
            gloss: "occasionally"
          },
          { id: "kitchen.cooking_in_progress.pinch_of", text: "It needs a pinch of salt." },
          {
            id: "kitchen.cooking_in_progress.boiling_over",
            text: "Watch out, it's about to boil over!"
          },
          {
            id: "kitchen.cooking_in_progress.almost_ready",
            text: "It's almost ready — a couple more minutes."
          }
        ]
      }
    ]
  },
  {
    id: "chores",
    name: "Household chores",
    weight: 0.8,
    cases: [
      {
        id: "chores.dividing_up",
        situation: "Splitting the housework",
        communicativeFunction: "Negotiating and assigning tasks",
        chunks: [
          { id: "chores.dividing_up.my_turn", text: "It's my turn to do the dishes." },
          { id: "chores.dividing_up.can_you_take", text: "Can you take care of the laundry?" },
          {
            id: "chores.dividing_up.ill_handle",
            text: "I'll handle the kitchen if you do the bathroom."
          },
          {
            id: "chores.dividing_up.pull_your_weight",
            text: "Everyone needs to pull their weight.",
            gloss: "do a fair share"
          },
          {
            id: "chores.dividing_up.lend_a_hand",
            text: "Could you lend me a hand for a sec?",
            gloss: "help me briefly"
          },
          { id: "chores.dividing_up.split_it", text: "Let's split it down the middle." }
        ]
      },
      {
        id: "chores.tidying_up",
        situation: "Tidying and cleaning the home",
        communicativeFunction: "Requesting and reporting tidying",
        chunks: [
          {
            id: "chores.tidying_up.pick_up_after",
            text: "Please pick up after yourself.",
            gloss: "tidy your own mess"
          },
          { id: "chores.tidying_up.put_away", text: "Can you put your things away?" },
          { id: "chores.tidying_up.wipe_down", text: "I'll wipe down the counters." },
          { id: "chores.tidying_up.run_the_vacuum", text: "Let me run the vacuum quickly." },
          { id: "chores.tidying_up.take_out_trash", text: "Don't forget to take out the trash." },
          { id: "chores.tidying_up.its_a_mess", text: "This place is a real mess." }
        ]
      },
      {
        id: "chores.things_breaking",
        situation: "Dealing with something broken at home",
        communicativeFunction: "Reporting a problem and proposing a fix",
        chunks: [
          {
            id: "chores.things_breaking.on_the_blink",
            text: "The washing machine is on the blink again.",
            gloss: "not working properly"
          },
          {
            id: "chores.things_breaking.acting_up",
            text: "The heater's been acting up.",
            gloss: "malfunctioning"
          },
          {
            id: "chores.things_breaking.call_someone",
            text: "We'd better call someone to fix it."
          },
          {
            id: "chores.things_breaking.give_it_a_go",
            text: "I'll give it a go myself first.",
            gloss: "try"
          },
          {
            id: "chores.things_breaking.packed_in",
            text: "The kettle's finally packed in.",
            gloss: "stopped working for good"
          },
          { id: "chores.things_breaking.hold_off", text: "Let's hold off until the weekend." }
        ]
      }
    ]
  },
  {
    id: "childcare",
    name: "Childcare & family",
    weight: 0.7,
    cases: [
      {
        id: "childcare.morning_routine",
        situation: "Getting the kids ready in the morning",
        communicativeFunction: "Urging and coordinating a routine",
        chunks: [
          {
            id: "childcare.morning_routine.rise_and_shine",
            text: "Rise and shine, time to get up!"
          },
          { id: "childcare.morning_routine.running_late", text: "Hurry up, we're running late." },
          { id: "childcare.morning_routine.brush_your_teeth", text: "Go brush your teeth." },
          { id: "childcare.morning_routine.shoes_on", text: "Get your shoes on, please." },
          { id: "childcare.morning_routine.dont_forget_bag", text: "Don't forget your bag." },
          { id: "childcare.morning_routine.have_you_packed", text: "Have you packed your lunch?" }
        ]
      },
      {
        id: "childcare.bedtime",
        situation: "Settling a child down for bed",
        communicativeFunction: "Soothing and setting limits",
        chunks: [
          { id: "childcare.bedtime.lights_out", text: "Five more minutes, then lights out." },
          {
            id: "childcare.bedtime.tuck_you_in",
            text: "Let me tuck you in.",
            gloss: "settle you under the covers"
          },
          { id: "childcare.bedtime.one_more_story", text: "Just one more story, okay?" },
          { id: "childcare.bedtime.settle_down", text: "Settle down now, it's late." },
          { id: "childcare.bedtime.sweet_dreams", text: "Sweet dreams." },
          { id: "childcare.bedtime.back_to_bed", text: "Off you go, back to bed." }
        ]
      },
      {
        id: "childcare.behaviour",
        situation: "Managing a child's behaviour",
        communicativeFunction: "Praising, warning, and reasoning",
        chunks: [
          { id: "childcare.behaviour.good_job", text: "Good job, I'm proud of you!" },
          {
            id: "childcare.behaviour.knock_it_off",
            text: "Knock it off, please.",
            gloss: "stop that"
          },
          { id: "childcare.behaviour.say_youre_sorry", text: "Say you're sorry to your sister." },
          { id: "childcare.behaviour.share_with", text: "You need to share with your brother." },
          { id: "childcare.behaviour.last_warning", text: "This is your last warning." },
          { id: "childcare.behaviour.calm_down", text: "Take a deep breath and calm down." }
        ]
      }
    ]
  },
  {
    id: "small_talk",
    name: "Small talk",
    weight: 0.85,
    cases: [
      {
        id: "small_talk.greetings",
        situation: "Greeting someone you know",
        communicativeFunction: "Opening a conversation warmly",
        chunks: [
          { id: "small_talk.greetings.hows_it_going", text: "Hey, how's it going?" },
          { id: "small_talk.greetings.long_time", text: "Long time no see!" },
          { id: "small_talk.greetings.whats_new", text: "So what's new with you?" },
          {
            id: "small_talk.greetings.cant_complain",
            text: "Can't complain — and you?",
            gloss: "things are fine"
          },
          { id: "small_talk.greetings.keeping_busy", text: "Keeping busy, the usual." },
          { id: "small_talk.greetings.good_to_see", text: "Good to see you!" }
        ]
      },
      {
        id: "small_talk.weather",
        situation: "Chatting about the weather",
        communicativeFunction: "Filling a pause with safe common ground",
        chunks: [
          { id: "small_talk.weather.lovely_day", text: "Lovely day, isn't it?" },
          { id: "small_talk.weather.bit_chilly", text: "It's a bit chilly out there today." },
          {
            id: "small_talk.weather.pouring",
            text: "It's absolutely pouring.",
            gloss: "raining heavily"
          },
          { id: "small_talk.weather.warming_up", text: "Looks like it's finally warming up." },
          {
            id: "small_talk.weather.cant_make_mind",
            text: "The weather can't make its mind up.",
            usageNote: "Light humour about changeable weather."
          },
          { id: "small_talk.weather.wrap_up_warm", text: "Wrap up warm out there." }
        ]
      },
      {
        id: "small_talk.wrapping_up",
        situation: "Ending a casual conversation",
        communicativeFunction: "Closing politely and leaving the door open",
        chunks: [
          { id: "small_talk.wrapping_up.id_better_go", text: "Anyway, I'd better get going." },
          { id: "small_talk.wrapping_up.lovely_chatting", text: "It was lovely chatting." },
          { id: "small_talk.wrapping_up.catch_up_soon", text: "Let's catch up soon." },
          { id: "small_talk.wrapping_up.take_care", text: "Take care of yourself." },
          { id: "small_talk.wrapping_up.say_hi_to", text: "Say hi to the family for me." },
          { id: "small_talk.wrapping_up.keep_in_touch", text: "Keep in touch!" }
        ]
      }
    ]
  },
  {
    id: "errands",
    name: "Errands & shopping",
    weight: 0.75,
    cases: [
      {
        id: "errands.at_the_shop",
        situation: "Buying things at a shop",
        communicativeFunction: "Asking for and finding what you need",
        chunks: [
          { id: "errands.at_the_shop.do_you_have", text: "Do you have this in a larger size?" },
          { id: "errands.at_the_shop.where_can_i_find", text: "Where can I find the milk?" },
          { id: "errands.at_the_shop.just_looking", text: "I'm just looking, thanks." },
          { id: "errands.at_the_shop.how_much_is", text: "How much is this?" },
          { id: "errands.at_the_shop.out_of_stock", text: "Is this out of stock?" },
          { id: "errands.at_the_shop.ill_take_it", text: "I'll take it." }
        ]
      },
      {
        id: "errands.paying",
        situation: "Paying at the checkout",
        communicativeFunction: "Completing a transaction",
        chunks: [
          { id: "errands.paying.card_or_cash", text: "Card or cash?" },
          { id: "errands.paying.on_card", text: "I'll pay on card." },
          { id: "errands.paying.need_a_bag", text: "Do you need a bag?" },
          { id: "errands.paying.keep_the_change", text: "Keep the change." },
          { id: "errands.paying.receipt_please", text: "Could I get a receipt, please?" },
          { id: "errands.paying.is_that_everything", text: "Is that everything for you today?" }
        ]
      },
      {
        id: "errands.running_around",
        situation: "Planning errands for the day",
        communicativeFunction: "Listing and sequencing tasks",
        chunks: [
          {
            id: "errands.running_around.pop_to",
            text: "I need to pop to the post office.",
            gloss: "make a quick visit"
          },
          { id: "errands.running_around.few_things", text: "I've got a few things to pick up." },
          { id: "errands.running_around.on_the_way", text: "I'll grab it on the way home." },
          {
            id: "errands.running_around.run_out_of",
            text: "We've run out of coffee.",
            gloss: "have none left"
          },
          { id: "errands.running_around.while_im_out", text: "Anything you need while I'm out?" },
          {
            id: "errands.running_around.back_in_a_bit",
            text: "I'll be back in a bit.",
            gloss: "soon"
          }
        ]
      }
    ]
  }
];

// The frozen seed corpus. The server reads this to seed domains, cases, and chunks.
export const caseCorpus: ReadonlyArray<CorpusDomain> = Object.freeze(
  corpusDefinitions.map(freezeDomain)
);

export function getCorpusDomain(id: string): CorpusDomain | undefined {
  return caseCorpus.find((domain) => domain.id === id);
}
