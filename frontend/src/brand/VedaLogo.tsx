type Props = {
  size?: number;
};

export function VedaLogo({ size = 56 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 160 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="veda-purple" x1="80" y1="18" x2="80" y2="62">
          <stop stopColor="#E79BDD" />
          <stop offset="1" stopColor="#7D3C8B" />
        </linearGradient>
        <linearGradient id="veda-gold-left" x1="24" y1="54" x2="72" y2="108">
          <stop stopColor="#FFE69A" />
          <stop offset="1" stopColor="#B88933" />
        </linearGradient>
        <linearGradient id="veda-gold-bottom" x1="18" y1="82" x2="52" y2="126">
          <stop stopColor="#FFD977" />
          <stop offset="1" stopColor="#C08B30" />
        </linearGradient>
        <linearGradient id="veda-green-right" x1="98" y1="54" x2="138" y2="106">
          <stop stopColor="#E0F06A" />
          <stop offset="1" stopColor="#648C27" />
        </linearGradient>
        <linearGradient id="veda-green-bottom" x1="108" y1="76" x2="146" y2="124">
          <stop stopColor="#D4F15C" />
          <stop offset="1" stopColor="#6F9D2B" />
        </linearGradient>
        <linearGradient id="veda-core" x1="44" y1="38" x2="118" y2="122">
          <stop stopColor="#29134A" />
          <stop offset="1" stopColor="#071427" />
        </linearGradient>
        <linearGradient id="veda-circuit" x1="52" y1="42" x2="112" y2="116">
          <stop stopColor="#CDA8FF" />
          <stop offset="1" stopColor="#4DA5FF" />
        </linearGradient>
      </defs>

      <path
        d="M80 18C95 30 106 45 112 62C100 54 89 50 80 50C71 50 60 54 48 62C54 45 65 30 80 18Z"
        fill="url(#veda-purple)"
      />
      <path
        d="M26 58C48 58 64 64 77 80C55 83 40 80 26 70C22 66 20 61 26 58Z"
        fill="url(#veda-gold-left)"
      />
      <path
        d="M16 86C34 84 48 89 62 102C42 106 28 103 16 94C11 91 12 88 16 86Z"
        fill="url(#veda-gold-bottom)"
      />
      <path
        d="M134 58C112 58 96 64 83 80C105 83 120 80 134 70C138 66 140 61 134 58Z"
        fill="url(#veda-green-right)"
      />
      <path
        d="M144 86C126 84 112 89 98 102C118 106 132 103 144 94C149 91 148 88 144 86Z"
        fill="url(#veda-green-bottom)"
      />
      <path
        d="M82 40C105 40 121 58 121 80C121 104 105 120 82 120C59 120 43 104 43 80C43 58 59 40 82 40Z"
        fill="url(#veda-core)"
        stroke="#29134A"
        strokeWidth="4"
      />
      <path
        d="M81.5 50V109.5M81.5 50C76 50 72 53 72 58V74M81.5 50C87 50 91 53 91 58V74M72 74L58 64M72 74L58 84M72 74V90M91 74L105 64M91 74L105 84M91 74V90M58 64L52 69M58 84L52 90M72 90L63 98M91 90L100 98M105 64L111 69M105 84L111 90"
        stroke="url(#veda-circuit)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="52" cy="69" r="4.5" fill="#C7A7FF" />
      <circle cx="52" cy="90" r="4.5" fill="#C7A7FF" />
      <circle cx="63" cy="98" r="4.5" fill="#C7A7FF" />
      <circle cx="100" cy="98" r="4.5" fill="#63A9FF" />
      <circle cx="111" cy="69" r="4.5" fill="#63A9FF" />
      <circle cx="111" cy="90" r="4.5" fill="#63A9FF" />
      <circle cx="72" cy="58" r="5" fill="#D1B5FF" />
      <circle cx="91" cy="58" r="5" fill="#8CC1FF" />
      <path
        d="M35 127C50 123 64 122 80 122C96 122 110 123 125 127"
        stroke="#8F7B3D"
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  );
}
