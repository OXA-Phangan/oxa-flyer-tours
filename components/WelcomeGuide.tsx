"use client";

import { openMapsLink } from "@/lib/open-maps";

// Welcome guide for volunteers (Dreamfactory house / Koh Phangan). Content and pictures come from
// the PDF "Welcome guide Dreamfactory / Koh Phangan" (2026-11-06). Always English, like the rest of
// the volunteer portal. Readable from the moment a volunteer is approved (before arrival too).

type Place = { label: string; url: string };
type Item = {
  title: string;
  text: string;
  /** "➢ Recommendations: …" lines */
  recs?: string[];
  places?: Place[];
  img?: { src: string; alt: string };
};
type Group = { label?: string; items: Item[] };
type Section = { title: string; groups: Group[]; outro?: "blog" };

export const BLOG_3_DAYS_URL = "https://oxabeachkohphangan.com/3-days-in-koh-phangan-the-perfect-weekend-tour/";

const SECTIONS: Section[] = [
  {
    title: "The Basics",
    groups: [
      {
        label: "Laundry",
        items: [
          {
            title: "Sunshine Laundry",
            text: "This is a self service coin laundry. This is the cheapest option for doing your laundry, so I would highly recommend it. Getting here is just a 5 minutes walk towards the Makro supermarket.",
            places: [{ label: "Sunshine Laundry", url: "https://maps.app.goo.gl/XKdagfWHv1tNnAZA6" }],
            img: { src: "/welcome/laundry.jpg", alt: "Sunshine Laundry" },
          },
          {
            title: "Full service laundry",
            text: "You don’t want to wait for your laundry, but just give it to someone and come pick it up a few hours later…? Across from the Big C supermarket, there is a full service laundry shop, which is just a 3 minutes walk from the house.",
            places: [{ label: "Full service laundry", url: "https://maps.app.goo.gl/KGwuPx9bREqULVjL8" }],
          },
        ],
      },
      {
        label: "Supermarkets",
        items: [
          {
            title: "7-Eleven",
            text: "Thailand is famous for having many 7-Elevens. The closest one to the house is across the road, can’t miss it.",
          },
          {
            title: "Makro / Big C",
            text: "If you’re looking for a cheaper alternative to the 7-Elevens, either the Makro supermarket or the Big C supermarket are the places to be. Personally, I recommend getting your drinks and snacks here, since it is way cheaper. They don’t only sell food or drinks, but also some clothes or even basic furniture.",
            places: [
              { label: "Big C", url: "https://maps.app.goo.gl/KGwuPx9bREqULVjL8" },
              { label: "Makro", url: "https://maps.app.goo.gl/SDcY1JNvtEavshjPA" },
            ],
          },
        ],
      },
    ],
  },
  {
    title: "Where to Eat",
    groups: [
      {
        label: "Breakfast / Lunch",
        items: [
          {
            title: "Southway or HOB",
            text: "With just a 2 minutes walk, there are 2 cafes right next to each other that serve (mostly western) breakfast/lunch. They have a pretty extensive menu, regarding both food and drinks. Moreover, the waiters are also really nice and fast. Since the quality is good, the prices are also higher. This picture was taken at Southway.",
            recs: ["The bread at HOB is better, but I prefer the coffee at Southway. Moreover, the pancakes at Southway are really good and they are really big."],
            places: [{ label: "Southway", url: "https://maps.app.goo.gl/oXtU2M9THVvku1oK6" }],
            img: { src: "/welcome/southway.jpg", alt: "Breakfast at Southway" },
          },
          {
            title: "Nine Restaurant & Bar",
            text: "If you are looking for a cheaper and more local place to eat, you should go here. They have a lot of Thai dishes to choose from, but they also have some sandwiches, yoghurt, or pancakes for breakfast. If you want to, you can even play pool while waiting for your food.",
            recs: ["The pancakes here are really good, just like the club sandwich."],
            places: [{ label: "Nine Restaurant & Bar", url: "https://maps.app.goo.gl/6CfH6WLqPRjTrReH8" }],
          },
          {
            title: "Hundred Islands Coffee Bar",
            text: "This is one of my favorite places to have breakfast at. It is a bit further away, 10 minutes walking, but definitely worth it. It is still expensive, but cheaper than Southway or HOB. They both serve international or local food.",
            recs: ["The BLT baguette or an avocado toast! And try out the iced cappuccino as well."],
            places: [{ label: "Hundred Islands Coffee Bar", url: "https://maps.app.goo.gl/TB649dcnUVkGmKRm9" }],
          },
        ],
      },
      {
        label: "Dinner",
        items: [
          {
            title: "Phangan food court",
            text: "Turn to the right from the house, walk 15 minutes, and you will see a small food court on your right side. This is an excellent place to grab dinner! They have a lot of Thai food, and the prices are way cheaper than eating at a restaurant.",
            places: [{ label: "Phangan food court", url: "https://maps.app.goo.gl/bSsk2CrXckFhpcaG6" }],
          },
          {
            title: "Around Sunshine Laundry",
            text: "There are a lot of restaurants to choose from (Thai, Mexican, Italian, etc). I recommend just walking towards that direction and trying out whatever looks good.",
          },
          {
            title: "Pantip market",
            text: "During the days that you will be handing out flyers, you will probably end up eating here. This is a great market, with a variety of options to choose from. Also, it is just a 30 minutes walk from the hostel. The ambiance is amazing, and they also sell clothes and souvenirs there.",
            places: [{ label: "Pantip market", url: "https://maps.app.goo.gl/2j8rqLU9uYxbUGA89" }],
            img: { src: "/welcome/pantip.jpg", alt: "Pantip market" },
          },
          {
            title: "At Chiang Mai",
            text: "This Thai restaurant is a true hidden gem of Koh Phangan. It is a 30 minutes walk from the house, but just a 5 minutes drive if you can use the scooter. If you walk through the restaurant, to the back, you will find a nice and relaxed place to sit and have dinner. I recommend getting the fried noodles with tofu, and try out one of their smoothies or the fresh coconut!",
            places: [{ label: "At Chiang Mai", url: "https://maps.app.goo.gl/SUJeFE9CKwzKatZz6" }],
            img: { src: "/welcome/chiangmai.jpg", alt: "Dinner at At Chiang Mai" },
          },
          {
            title: "Mama’s",
            text: "A little bit further down the road from At Chiang Mai, there is a sort of street food stand called Mama’s. Here, you can get freshly cooked Thai food for a really cheap price. You can get something to drink across the street, and there are some places to sit. I recommend getting the yellow noodles or the Pad Thai.",
            places: [{ label: "Mama’s", url: "https://maps.app.goo.gl/szWLezfMKSkA7qms9" }],
          },
        ],
      },
    ],
  },
  {
    title: "What to eat / drink – The Thai version",
    groups: [
      {
        items: [
          {
            title: "Pad Thai",
            text: "This might be one of the most famous Thai dishes. It includes fried noodles, eggs, some kind of meat (your choice), and some other vegetables. A must try if you ask me!",
            img: { src: "/welcome/padthai.jpg", alt: "Pad Thai" },
          },
          {
            title: "Som Tam",
            text: "This basically is a papaya salad. If you like spices, you should ask them to make it spicy beforehand. They usually make it without spices for tourists!",
          },
          {
            title: "Moo nam tok",
            text: "This is a grilled pork salad. This one can be a little bit more spicy than other dishes.",
          },
          {
            title: "Penang curry",
            text: "Thailand is also famous for its curries. This one is not too spicy, but very tasty. It is made of red curry paste, coconut milk, and some kind of protein source (chicken, tofu, etc.).",
          },
          {
            title: "Smoothies",
            text: "At the food courts, they usually also sell a lot of smoothies. Personally, I really like them. I recommend trying one with banana, milk, and some other ingredients. Bananas make the smoothie texture extra tasty, and without the milk the smoothie can become very icy. Personally, my favorite one is the one with banana, mango, and strawberry (with milk).",
          },
        ],
      },
    ],
  },
  {
    title: "What to Do on your Free Days",
    groups: [
      {
        items: [
          {
            title: "Saturday Night Market",
            text: "Did you arrive on a Saturday? Lucky you. Now you have the chance to go check it out and grab dinner here. It is a long walking street with both clothing and all kinds of food (Thai, western, you name it). The prices are really cheap, and the ambiance is great.",
            places: [{ label: "Saturday Night Market", url: "https://maps.app.goo.gl/d5YevC45kHfXSpWQA" }],
          },
          {
            title: "Tong Sala Beach",
            text: "This is the closest beach to the house. Take a left, from the house, and then the first one on the right. If you pass Kohmunity Hostel on your way to the beach, you know that you’re on the right path. Personally, I recommend walking to the left when you’ve arrived at the beach. After a while there are some chairs or other places where you can relax, listen to some music or read a book.",
            places: [{ label: "Tong Sala Beach", url: "https://maps.app.goo.gl/FSx9P49mfxzsYTtPA" }],
          },
          {
            title: "Other beaches",
            text: "On the north side of the island, there are some beaches that are even more beautiful than the Tong Sala Beach. You have to rent a scooter if you want to go here. I recommend going to a beach in the North West of the Island (I recommend Zen Beach, which is where this picture was taken) to see the sunset. Moreover, Malibu Beach or Mae Haad Beach are also really great places to chill and swim at.",
            places: [{ label: "Zen Beach", url: "https://maps.app.goo.gl/wH41vgGVa9dyywmUA" }],
            img: { src: "/welcome/zenbeach.jpg", alt: "Sunset at Zen Beach" },
          },
          {
            title: "Dinner at the Sunday Market",
            text: "Near Malibu Beach, there is the Sunday Market on Sunday. Just like the Saturday Night Market, this is a great place to grab some dinner for a really good price.",
            places: [{ label: "Sunday Market", url: "https://maps.app.goo.gl/ELwV34UVKVzDzBy68" }],
            img: { src: "/welcome/sundaymarket.jpg", alt: "Sunday Market" },
          },
          {
            title: "Hang out at Kohmunity Hostel",
            text: "If you want to meet more people, and have a fun night, this is the place to be. It’s just across the street to the left, maybe 2 minutes walking. They got a nice pool, games and outsiders are very welcome.",
          },
        ],
      },
    ],
    outro: "blog",
  },
];

const cardClass = "rounded-2xl border border-[#E2DFD6] bg-white";

export default function WelcomeGuide({ onBack }: { onBack: () => void }) {
  return (
    <main className="flex min-h-screen flex-1 justify-center bg-[#EFEDE7] px-4 py-8 text-[#201E1B]">
      <div className="w-full max-w-md">
        <button type="button" onClick={onBack} className="mb-4 text-sm font-semibold underline">
          ← Back
        </button>
        <h1 className="text-2xl font-semibold">Welcome guide</h1>
        <p className="mb-4 text-sm text-[#5C5850]">Dreamfactory / Koh Phangan</p>
        <p className="mb-6 text-[15px] leading-relaxed">
          Hello and welcome to Koh Phangan! Are you excited to start your journey here? Yes? Great! Here is some information,
          tips, and tricks that might come in handy for your first few days here:
        </p>

        <div className="space-y-8">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h2 className="mb-3 text-xl font-semibold">{s.title}</h2>
              <div className="space-y-5">
                {s.groups.map((g, gi) => (
                  <div key={gi}>
                    {g.label && (
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#8A857A]">{g.label}</p>
                    )}
                    <div className="space-y-3">
                      {g.items.map((it) => (
                        <ItemCard key={it.title} item={it} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {s.outro === "blog" && (
                <p className="mt-4 text-[15px] leading-relaxed">
                  Of course there is lots of other stuff to do and explore on the island (other beaches, waterfalls, sunset
                  spots, etc…). You might want to check out{" "}
                  <a href={BLOG_3_DAYS_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                    this blog
                  </a>{" "}
                  where you can also find an itinerary on what to do on your free days! The itinerary is from Friday till
                  Sunday, and gives you the perfect way of exploring the island in just 3 days!
                </p>
              )}
            </section>
          ))}

          <section>
            <h2 className="mb-3 text-xl font-semibold">The House</h2>
            <div className={`${cardClass} space-y-3 p-4 text-[15px] leading-relaxed`}>
              <p>
                Together with the other volunteers you are going to live here for the next couple of days. You and the other
                volunteers are responsible for how clean the place is. Just discuss with the other volunteers when you think
                it is a big mess and when or how to clean it. Extra toilet bags or toilet papers, or cleaning materials can be
                found in the kitchen.
              </p>
              <p>
                Moreover, the air conditioning automatically turns on at 9.30 PM. If you want some extra breeze during the day,
                you can always turn one of the fans on. Make sure to turn it off when you’re leaving.
              </p>
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold">Extra Tips and Tricks</h2>
            <div className={`${cardClass} p-4 text-[15px] leading-relaxed`}>
              <p className="mb-2 font-semibold">❖ Scooter rental</p>
              <p>
                On your free days, you will have a lot of time to explore the island. In order to do this, you have to rent a
                scooter. You can work an hour extra, and get the scooter for an extra day (ask Mo for the details!), or you can
                rent one. <b>Do not</b> rent a scooter on the big scooter rental place when you turn right from the house. They
                will charge you extra for even making a tiny scratch (some volunteers had to pay 10000 baht). Instead, rent one
                at Earn Bike for Rent or even better… ask Mo if you can rent one of OXA’s scooters.
              </p>
              <PlaceButtons places={[{ label: "Earn Bike for Rent", url: "https://maps.app.goo.gl/dwA4keMMvk19tqfK9" }]} />
            </div>
          </section>
        </div>

        <button
          type="button"
          onClick={onBack}
          className="mt-8 w-full rounded-2xl border border-[#E2DFD6] bg-white px-4 py-4 text-base font-semibold text-[#201E1B]"
        >
          Back
        </button>
      </div>
    </main>
  );
}

function PlaceButtons({ places }: { places: Place[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {places.map((p) => (
        <a
          key={p.url + p.label}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => openMapsLink(e, p.url, null)}
          className="rounded-xl border border-[#BDB6A2] bg-[#E9E4D6] px-3 py-2 text-sm font-semibold text-[#201E1B]"
        >
          📍 {p.label}
        </a>
      ))}
    </div>
  );
}

function ItemCard({ item }: { item: Item }) {
  return (
    <div className={`${cardClass} overflow-hidden`}>
      {item.img && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.img.src} alt={item.img.alt} loading="lazy" className="h-48 w-full object-cover" />
      )}
      <div className="p-4 text-[15px] leading-relaxed">
        <p className="mb-1 font-semibold">❖ {item.title}</p>
        <p>{item.text}</p>
        {item.recs?.map((r) => (
          <p key={r} className="mt-2 rounded-xl bg-[#FBF9F4] p-3 text-sm">
            <b>➢ Recommendations:</b> {r}
          </p>
        ))}
        {item.places && <PlaceButtons places={item.places} />}
      </div>
    </div>
  );
}
